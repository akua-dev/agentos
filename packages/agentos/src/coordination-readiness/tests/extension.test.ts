import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { BackgroundTaskBroker } from "../../background-tasks/broker.ts";
import type {
  BackgroundCommandRequest,
  TaskHandle,
  TaskTerminalResult,
} from "../../background-tasks/types.ts";
import { registerCoordinationReadiness } from "../extension.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;

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
  return {
    requests,
    controls,
    async start(request: BackgroundCommandRequest): Promise<TaskHandle> {
      requests.push(request);
      const terminal = deferred<TaskTerminalResult>();
      controls.push(terminal);
      return {
        completion: terminal.promise,
        processId: 9001,
        stop: async () => {
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

class FakePi {
  readonly tools = new Map<string, AnyToolDefinition>();

  registerTool(tool: AnyToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  extensionApi() {
    return this as unknown as ExtensionAPI;
  }
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

async function temporaryRoot() {
  const directory = await mkdtemp(join(tmpdir(), "agentos-coordination-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(path: string, exists: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await Bun.file(path).exists()) === exists) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${path} existence=${exists}`);
}

describe("coordination semantic readiness", () => {
  test("attests listener registration, confirms catch-up, and invalidates terminal work", async () => {
    const root = await temporaryRoot();
    const commands = controlledCommands();
    const broker = new BackgroundTaskBroker({
      rootDirectory: join(root, "background"),
      startCommand: commands.start,
      createId: () => "bg-listener",
    });
    const pi = new FakePi();
    registerCoordinationReadiness(pi.extensionApi(), {
      broker,
      environment: {
        AGENTOS_AGENT_NAME: "firstmate",
        HERDR_SESSION: "agentos-firstmate",
      },
      processId: 4242,
      stateDirectory: root,
    });

    await broker.start({
      command:
        "pg-listen agentos_mate_00000000000040008000000000000001",
      completionDelivery: "steer",
      description:
        "[agentos-supervision] wait for a durable current-Mate event",
      readyOutput: '"state":"listening"',
    });
    await execute(pi.tools.get("attest_coordination_listener"), {
      listener_task_id: "bg-listener",
    });

    const statePath = join(root, "readiness", "coordination.json");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      agentName: "firstmate",
      herdrSession: "agentos-firstmate",
      listenerTaskId: "bg-listener",
      listenerProcessId: 9001,
      ownerProcessId: 4242,
      phase: "listening",
      version: 1,
    });

    await execute(pi.tools.get("confirm_coordination_catchup"), {
      listener_task_id: "bg-listener",
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      listenerTaskId: "bg-listener",
      phase: "caught_up",
    });

    commands.controls[0]!.resolve({
      state: "succeeded",
      summary: "Notification received",
      exitCode: 0,
    });
    await waitForFile(statePath, false);
  });

  test("rejects a listener claim that is not the exact safe native contract", async () => {
    const root = await temporaryRoot();
    const commands = controlledCommands();
    const broker = new BackgroundTaskBroker({
      rootDirectory: join(root, "background"),
      startCommand: commands.start,
      createId: () => "bg-unsafe",
    });
    const pi = new FakePi();
    registerCoordinationReadiness(pi.extensionApi(), {
      broker,
      environment: {
        AGENTOS_AGENT_NAME: "firstmate",
        HERDR_SESSION: "agentos-firstmate",
      },
      processId: 4242,
      stateDirectory: root,
    });

    await broker.start({
      command:
        "pg-listen agentos_mate_00000000000040008000000000000001 && echo unsafe",
      completionDelivery: "steer",
      description:
        "[agentos-supervision] wait for a durable current-Mate event",
      readyOutput: '"state":"listening"',
    });

    await expect(
      execute(pi.tools.get("attest_coordination_listener"), {
        listener_task_id: "bg-unsafe",
      }),
    ).rejects.toThrow("does not satisfy the coordination listener contract");
    expect(
      await Bun.file(join(root, "readiness", "coordination.json")).exists(),
    ).toBe(false);
  });
});
