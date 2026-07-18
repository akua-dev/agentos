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

  appendEntry() {}

  extensionApi() {
    return this as unknown as ExtensionAPI;
  }

  async emit(event: string) {
    const context = {
      sessionManager: { getEntries: () => [] },
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
