import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackgroundTaskBroker } from "../broker.ts";
import type {
  BackgroundCommandRequest,
  TaskEvent,
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
  const controls: Array<{
    terminal: ReturnType<typeof deferred<TaskTerminalResult>>;
    stops: number;
  }> = [];
  return {
    requests,
    controls,
    async start(request: BackgroundCommandRequest): Promise<TaskHandle> {
      requests.push(request);
      const terminal = deferred<TaskTerminalResult>();
      const control = { terminal, stops: 0 };
      controls.push(control);
      return {
        completion: terminal.promise,
        stop: async () => {
          control.stops += 1;
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

async function broker() {
  const directory = await mkdtemp(join(tmpdir(), "agentos-broker-"));
  temporaryDirectories.push(directory);
  const commands = controlledCommands();
  const events: TaskEvent[] = [];
  let sequence = 0;
  const instance = new BackgroundTaskBroker({
    startCommand: commands.start,
    rootDirectory: directory,
    createId: () => `task-${++sequence}`,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  });
  instance.onEvent((event) => events.push(event));
  return { instance, commands, directory, events };
}

describe("BackgroundTaskBroker", () => {
  test("assigns stable IDs and records one terminal transition", async () => {
    const { instance, commands, events } = await broker();
    const started = await instance.start({
      command: "bun test",
      description: "Run tests",
    });

    commands.controls[0]!.terminal.resolve({
      state: "succeeded",
      summary: "Command completed",
      exitCode: 0,
    });
    const completed = await instance.get(started.id, { waitMs: 100 });

    expect(started.id).toBe("task-1");
    expect(completed).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      completionObserved: true,
    });
    expect(events.filter(({ type }) => type === "task_terminal")).toHaveLength(1);
  });

  test("keeps output pull-based and bounded", async () => {
    const { instance, commands, directory } = await broker();
    const started = await instance.start({
      command: "printf abcdef",
      description: "Print output",
    });
    await writeFile(join(directory, `${started.id}.log`), "abcdef");
    commands.controls[0]!.terminal.resolve({
      state: "succeeded",
      summary: "Command completed",
      exitCode: 0,
    });
    await instance.get(started.id, { waitMs: 100, outputBytes: 3 });

    expect(await instance.list()).toEqual([
      expect.objectContaining({ id: started.id, outputTail: "" }),
    ]);
    expect(await instance.get(started.id, { outputBytes: 3 })).toMatchObject({
      outputTail: "def",
      outputTruncated: true,
      outputBytes: 6,
    });
  });

  test("kills a task once and suppresses its terminal wake", async () => {
    const { instance, commands, events } = await broker();
    const started = await instance.start({
      command: "sleep 10",
      description: "Wait",
    });

    const killed = await instance.kill(started.id);

    expect(killed).toMatchObject({
      state: "cancelled",
      explicitlyKilled: true,
      completionObserved: true,
    });
    expect(commands.controls[0]!.stops).toBe(1);
    expect(events.filter(({ type }) => type === "task_terminal")).toHaveLength(1);
  });

  test("shutdown stops all running commands without emitting model wakes", async () => {
    const { instance, commands, events } = await broker();
    await instance.start({ command: "sleep 10", description: "First wait" });
    await instance.start({ command: "sleep 20", description: "Second wait" });

    await instance.shutdown();

    expect(commands.controls.map(({ stops }) => stops)).toEqual([1, 1]);
    expect(
      events
        .filter(({ type }) => type === "task_terminal")
        .every(({ task }) => task.completionObserved),
    ).toBe(true);
  });
});
