import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { registerAgentosBackgroundTasks } from "../extension.ts";
import type {
  BackgroundCommandRequest,
  TaskHandle,
  TaskTerminalResult,
} from "../types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function controlledCommands() {
  const requests: BackgroundCommandRequest[] = [];
  const controls: Array<ReturnType<typeof deferred<TaskTerminalResult>>> = [];
  const stops: number[] = [];
  return {
    requests,
    controls,
    stops,
    async start(request: BackgroundCommandRequest): Promise<TaskHandle> {
      requests.push(request);
      const terminal = deferred<TaskTerminalResult>();
      const index = controls.push(terminal) - 1;
      stops[index] = 0;
      return {
        completion: terminal.promise,
        stop: async () => {
          stops[index] = (stops[index] ?? 0) + 1;
          const result: TaskTerminalResult = {
            state: "cancelled",
            summary: "Command killed",
          };
          terminal.resolve(result);
          return result;
        },
      };
    },
  };
}

type AnyToolDefinition = ToolDefinition<any, any, any>;
type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

class FakePi {
  readonly tools = new Map<string, AnyToolDefinition>();
  readonly commands = new Map<
    string,
    {
      description: string;
      handler: (args: string, context: ExtensionContext) => Promise<void>;
    }
  >();
  readonly handlers = new Map<string, EventHandler[]>();
  readonly messages: Array<{ message: any; options: unknown }> = [];
  readonly entries: Array<{
    type: "custom";
    customType: string;
    data: unknown;
  }>;

  constructor(
    entries: Array<{
      type: "custom";
      customType: string;
      data: unknown;
    }> = [],
  ) {
    this.entries = [...entries];
  }

  registerTool(tool: AnyToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, context: ExtensionContext) => Promise<void>;
    },
  ) {
    this.commands.set(name, command);
  }

  on(
    event: string,
    handler: EventHandler,
  ) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: any, options: unknown) {
    this.messages.push({ message, options });
  }

  appendEntry(customType: string, data: unknown) {
    this.entries.push({ type: "custom", customType, data });
  }

  extensionApi() {
    return this as unknown as ExtensionAPI;
  }

  async emit(event: string) {
    const context = {
      sessionManager: {
        getBranch: () => this.entries,
        getEntries: () => this.entries,
      },
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ type: event }, context);
    }
  }
}

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "agentos-extension-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function execute(
  tool: AnyToolDefinition | undefined,
  params: Record<string, unknown>,
) {
  if (!tool) throw new Error("tool was not registered");
  return tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    {
      sessionManager: { getEntries: () => [] },
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext,
  );
}

describe("AgentOS Pi background commands", () => {
  test("registers the Grok-shaped command, output, list, and kill surface", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-one",
      batchDelayMs: 5,
    });

    expect([...pi.tools.keys()]).toEqual([
      "run_background_command",
      "get_background_command_output",
      "list_background_commands",
      "kill_background_command",
    ]);
    expect(pi.commands.has("background-commands")).toBe(true);

    const started = await execute(pi.tools.get("run_background_command"), {
      command: "bun test",
      description: "Run the focused tests",
      cwd: "/workspace",
    });

    expect(commands.requests).toEqual([
      {
        command: "bun test",
        description: "Run the focused tests",
        cwd: "/workspace",
      },
    ]);
    expect(started.details).toMatchObject({
      id: "bg-one",
      state: "running",
      command: "bun test",
    });
  });

  test("rejects failed tool execution through Pi's native error contract", async () => {
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      rootDirectory: await root(),
    });

    await expect(
      execute(pi.tools.get("get_background_command_output"), {
        task_id: "missing-task",
      }),
    ).rejects.toThrow("Unknown background command: missing-task");
  });

  test("reports a readiness start failure without claiming the command started", async () => {
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: async () => {
        throw new Error(
          'Background command did not produce readiness output "listening" within 20ms',
        );
      },
      rootDirectory: await root(),
      createId: () => "bg-not-ready",
      batchDelayMs: 5,
    });

    const result = await execute(pi.tools.get("run_background_command"), {
      command: "pg-listen agentos_events",
      description: "Wait for LISTEN readiness",
      ready_output: "listening",
      ready_timeout: 20,
    });
    await Bun.sleep(20);

    expect(result.details).toMatchObject({
      id: "bg-not-ready",
      state: "failed",
      summary: "Background command failed to start",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Background command "bg-not-ready" failed');
    expect(text).toContain("did not produce readiness output");
    expect(text).not.toContain("Started background command");
    expect(pi.messages).toEqual([]);
  });

  test("keeps the public timeout surface limited to ordinary failure", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-expiring",
    });

    const parameters = pi.tools.get("run_background_command")?.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(parameters.properties).not.toHaveProperty("timeout_behavior");
  });

  test("forwards a bounded literal readiness condition to the background command", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-ready",
    });

    await execute(pi.tools.get("run_background_command"), {
      command: "pg-listen agentos_events",
      description: "Wait for a Fleet event after LISTEN is registered",
      ready_output: '"state":"listening"',
      ready_timeout: 30_000,
    });

    expect(commands.requests).toEqual([
      {
        command: "pg-listen agentos_events",
        description: "Wait for a Fleet event after LISTEN is registered",
        readyOutput: '"state":"listening"',
        readyTimeout: 30_000,
      },
    ]);
  });

  test("defaults to running tasks and pages explicitly selected history", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    let sequence = 0;
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => `bg-${++sequence}`,
    });

    for (let index = 1; index <= 24; index += 1) {
      await execute(pi.tools.get("run_background_command"), {
        command: `command-${index}`,
        description: `Command ${index}`,
      });
    }
    for (const control of commands.controls.slice(0, 22)) {
      control.resolve({
        state: "succeeded",
        summary: "Command completed",
        exitCode: 0,
      });
    }
    await Bun.sleep(10);

    const running = await execute(pi.tools.get("list_background_commands"), {});
    const runningText = (running.content[0] as { text: string }).text;
    expect(runningText.split("\n")).toEqual([
      "bg-23 running Command 23",
      "bg-24 running Command 24",
    ]);
    expect(running.details).toMatchObject({
      tasks: [
        { id: "bg-23", state: "running" },
        { id: "bg-24", state: "running" },
      ],
    });

    const firstPage = await execute(
      pi.tools.get("list_background_commands"),
      { state: "succeeded", limit: 3 },
    );
    expect((firstPage.content[0] as { text: string }).text.split("\n").slice(0, 3))
      .toEqual([
      "bg-22 succeeded exit=0 Command 22",
      "bg-21 succeeded exit=0 Command 21",
      "bg-20 succeeded exit=0 Command 20",
    ]);
    expect(firstPage.details).toMatchObject({
      tasks: [
        { id: "bg-22" },
        { id: "bg-21" },
        { id: "bg-20" },
      ],
      nextCursor: "bg-20",
    });

    const all = await execute(pi.tools.get("list_background_commands"), {
      state: "all",
      limit: 1,
    });
    expect(
      (all.details as { tasks: Array<{ id: string }> }).tasks.map(({ id }) => id),
    ).toEqual(["bg-23", "bg-24", "bg-22"]);

    const secondPage = await execute(
      pi.tools.get("list_background_commands"),
      {
        state: "succeeded",
        limit: 3,
        before_task_id: "bg-20",
      },
    );
    expect(
      (secondPage.details as { tasks: Array<{ id: string }> }).tasks.map(
        ({ id }) => id,
      ),
    ).toEqual(["bg-19", "bg-18", "bg-17"]);
  });

  test("orders terminal history by completion time", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    let sequence = 0;
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => `bg-finished-${++sequence}`,
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "first",
      description: "Started first and finished last",
    });
    await Bun.sleep(2);
    await execute(pi.tools.get("run_background_command"), {
      command: "second",
      description: "Started second and finished first",
    });
    commands.controls[1]!.resolve({
      state: "succeeded",
      summary: "Second completed",
      exitCode: 0,
    });
    await Bun.sleep(2);
    commands.controls[0]!.resolve({
      state: "succeeded",
      summary: "First completed",
      exitCode: 0,
    });
    await Bun.sleep(10);

    const history = await execute(
      pi.tools.get("list_background_commands"),
      { state: "succeeded" },
    );
    expect(
      (history.details as { tasks: Array<{ id: string }> }).tasks.map(
        ({ id }) => id,
      ),
    ).toEqual(["bg-finished-1", "bg-finished-2"]);
  });

  test("persists lifecycle metadata and restores unfinished work as interrupted", async () => {
    const directory = await root();
    const firstCommands = controlledCommands();
    const firstPi = new FakePi();
    registerAgentosBackgroundTasks(firstPi.extensionApi(), {
      startCommand: firstCommands.start,
      rootDirectory: directory,
      createId: () => "bg-restart",
    });

    await execute(firstPi.tools.get("run_background_command"), {
      command: "pg-listen agentos_events",
      description: "[agentos-supervision] Wait for a durable Fleet event",
    });
    await writeFile(join(directory, "bg-restart.log"), "listener booted\n");

    expect(firstPi.entries).toEqual([
      expect.objectContaining({
        type: "custom",
        customType: "agentos-background-command-lifecycle",
        data: expect.objectContaining({
          version: 1,
          task: expect.objectContaining({
            id: "bg-restart",
            state: "running",
          }),
        }),
      }),
    ]);
    expect(
      (
        firstPi.entries[0]!.data as {
          task: Record<string, unknown>;
        }
      ).task,
    ).not.toHaveProperty("outputTail");

    const secondPi = new FakePi(firstPi.entries);
    registerAgentosBackgroundTasks(secondPi.extensionApi(), {
      startCommand: controlledCommands().start,
      rootDirectory: directory,
    });
    await secondPi.emit("session_start");

    const restored = await execute(
      secondPi.tools.get("list_background_commands"),
      { state: "interrupted" },
    );
    expect(restored.details).toMatchObject({
      tasks: [
        {
          id: "bg-restart",
          state: "interrupted",
          command: "pg-listen agentos_events",
          description: "[agentos-supervision] Wait for a durable Fleet event",
        },
      ],
    });
    const output = await execute(
      secondPi.tools.get("get_background_command_output"),
      { task_id: "bg-restart" },
    );
    expect((output.content[0] as { text: string }).text).toContain(
      "listener booted",
    );
    expect(secondPi.messages).toEqual([]);
  });

  test("restores shutdown cancellations as interrupted but preserves explicit kills", async () => {
    const directory = await root();
    const firstCommands = controlledCommands();
    const firstPi = new FakePi();
    let sequence = 0;
    registerAgentosBackgroundTasks(firstPi.extensionApi(), {
      startCommand: firstCommands.start,
      rootDirectory: directory,
      createId: () => `bg-restore-${++sequence}`,
    });

    await execute(firstPi.tools.get("run_background_command"), {
      command: "sleep 10",
      description: "Explicitly killed",
    });
    await execute(firstPi.tools.get("run_background_command"), {
      command: "sleep 20",
      description: "Stopped by Pi shutdown",
    });
    await execute(firstPi.tools.get("kill_background_command"), {
      task_id: "bg-restore-1",
    });
    await firstPi.emit("session_shutdown");

    const secondPi = new FakePi(firstPi.entries);
    registerAgentosBackgroundTasks(secondPi.extensionApi(), {
      startCommand: controlledCommands().start,
      rootDirectory: directory,
    });
    await secondPi.emit("session_start");

    const interrupted = await execute(
      secondPi.tools.get("list_background_commands"),
      { state: "interrupted" },
    );
    expect(interrupted.details).toMatchObject({
      tasks: [
        {
          id: "bg-restore-2",
          state: "interrupted",
          description: "Stopped by Pi shutdown",
        },
      ],
    });

    const cancelled = await execute(
      secondPi.tools.get("list_background_commands"),
      { state: "cancelled" },
    );
    expect(cancelled.details).toMatchObject({
      tasks: [
        {
          id: "bg-restore-1",
          state: "cancelled",
          explicitlyKilled: true,
        },
      ],
    });
  });

  test("checkpoints running lifecycle metadata on Pi tree navigation", async () => {
    const directory = await root();
    const firstPi = new FakePi();
    registerAgentosBackgroundTasks(firstPi.extensionApi(), {
      startCommand: controlledCommands().start,
      rootDirectory: directory,
      createId: () => "bg-tree",
    });
    await execute(firstPi.tools.get("run_background_command"), {
      command: "pg-listen agentos_events",
      description: "[agentos-supervision] Wait across tree navigation",
    });

    firstPi.entries.length = 0;
    await firstPi.emit("session_tree");

    expect(firstPi.entries).toEqual([
      expect.objectContaining({
        customType: "agentos-background-command-lifecycle",
        data: expect.objectContaining({
          task: expect.objectContaining({
            id: "bg-tree",
            state: "running",
          }),
        }),
      }),
    ]);

    const secondPi = new FakePi(firstPi.entries);
    registerAgentosBackgroundTasks(secondPi.extensionApi(), {
      startCommand: controlledCommands().start,
      rootDirectory: directory,
    });
    await secondPi.emit("session_start");
    const interrupted = await execute(
      secondPi.tools.get("list_background_commands"),
      { state: "interrupted" },
    );
    expect(interrupted.details).toMatchObject({
      tasks: [{ id: "bg-tree", state: "interrupted" }],
    });
  });

  test("surfaces a background start error in tool output", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-error",
      batchDelayMs: 5,
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "pg-listen agentos_events",
      description: "Listen for AgentOS events",
    });
    commands.controls[0]!.resolve({
      state: "failed",
      summary: "Background command failed to start",
      error: "Bun is not defined",
    });
    await Bun.sleep(20);

    const inspected = await execute(pi.tools.get("get_background_command_output"), {
      task_id: "bg-error",
    });
    expect((inspected.content[0] as { text: string }).text).toContain(
      "Error: Bun is not defined",
    );
  });

  test("separates terminal state from a terminating signal", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-signalled",
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "sleep 10",
      description: "Wait until stopped",
    });
    commands.controls[0]!.resolve({
      state: "cancelled",
      summary: "Command stopped",
      signal: "SIGTERM",
    });
    await Bun.sleep(10);

    const listed = await execute(
      pi.tools.get("list_background_commands"),
      { state: "cancelled" },
    );
    expect((listed.content[0] as { text: string }).text).toContain(
      "bg-signalled cancelled signal=SIGTERM Wait until stopped",
    );
  });

  test("natural completion wakes with metadata and a pull pointer but no output", async () => {
    const directory = await root();
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: directory,
      createId: () => "bg-result",
      batchDelayMs: 5,
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "bun test",
      description: "Run tests",
    });
    await writeFile(join(directory, "bg-result.log"), "SECRET OUTPUT\n");

    commands.controls[0]!.resolve({
      state: "succeeded",
      summary: "Command completed",
      exitCode: 0,
    });
    await Bun.sleep(20);

    expect(pi.messages).toHaveLength(1);
    const content = pi.messages[0]!.message.content as string;
    expect(content).toContain('Background command "bg-result" completed');
    expect(content).toContain("exit code 0");
    expect(content).toContain("bun test");
    expect(content).toContain("get_background_command_output");
    expect(content).not.toContain("SECRET OUTPUT");
    expect(pi.messages[0]).toMatchObject({
      options: { deliverAs: "followUp", triggerTurn: true },
    });
  });

  test("a blocking output read consumes completion without a duplicate wake", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-wait",
      batchDelayMs: 5,
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "kubectl wait pod/scout --for=condition=Ready",
      description: "Wait for Scout readiness",
    });
    const waiting = execute(pi.tools.get("get_background_command_output"), {
      task_id: "bg-wait",
      timeout_ms: 100,
    });

    commands.controls[0]!.resolve({
      state: "succeeded",
      summary: "Command completed",
      exitCode: 0,
    });

    expect((await waiting).details).toMatchObject({ completionObserved: true });
    await Bun.sleep(20);
    expect(pi.messages).toHaveLength(0);
  });

  test("an output read after completion consumes a pending wake", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => "bg-observed",
      batchDelayMs: 20,
    });
    await execute(pi.tools.get("run_background_command"), {
      command: "printf done",
      description: "Produce a result",
    });

    commands.controls[0]!.resolve({
      state: "succeeded",
      summary: "Command completed",
      exitCode: 0,
    });
    await Bun.sleep(1);
    expect(
      (
        await execute(pi.tools.get("get_background_command_output"), {
          task_id: "bg-observed",
        })
      ).details,
    ).toMatchObject({ completionObserved: true });

    await Bun.sleep(30);
    expect(pi.messages).toHaveLength(0);
  });

  test("explicit kill suppresses completion wake and shutdown stops every task", async () => {
    const commands = controlledCommands();
    const pi = new FakePi();
    let sequence = 0;
    registerAgentosBackgroundTasks(pi.extensionApi(), {
      startCommand: commands.start,
      rootDirectory: await root(),
      createId: () => `bg-${++sequence}`,
      batchDelayMs: 5,
    });
    for (const command of ["sleep 10", "sleep 20"]) {
      await execute(pi.tools.get("run_background_command"), {
        command,
        description: command,
      });
    }

    await execute(pi.tools.get("kill_background_command"), { task_id: "bg-1" });
    await pi.emit("session_shutdown");
    await Bun.sleep(20);

    expect(commands.stops).toEqual([1, 1]);
    expect(pi.messages).toHaveLength(0);
  });
});
