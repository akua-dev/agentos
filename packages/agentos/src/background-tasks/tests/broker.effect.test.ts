import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Deferred,
  Effect,
  FileSystem,
  Path,
  Ref,
} from "effect";
import { TestClock } from "effect/testing";

import { BackgroundTaskBroker } from "../broker.ts";
import { backgroundTaskFailure } from "../types.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskTerminalResult,
} from "../types.ts";

const platform = BunServices.layer;

function controlledCommands() {
  return Effect.gen(function*() {
    const completions = new Map<string, Deferred.Deferred<TaskTerminalResult>>();
    const stopCounts = yield* Ref.make(new Map<string, number>());
    const start: StartBackgroundCommand = (request) =>
      Effect.gen(function*() {
        const completion = yield* Deferred.make<TaskTerminalResult>();
        completions.set(request.command, completion);
        return {
          completion: Deferred.await(completion),
          processId: 4242,
          stop: () => Effect.gen(function*() {
            yield* Ref.update(stopCounts, (counts) => {
              const next = new Map(counts);
              next.set(request.command, (next.get(request.command) ?? 0) + 1);
              return next;
            });
            const result: TaskTerminalResult = {
              state: "cancelled",
              summary: "Background command killed",
              signal: "SIGTERM",
            };
            yield* Deferred.succeed(completion, result);
            return result;
          }),
        };
      });
    return {
      complete: (command: string, result: TaskTerminalResult) => {
        const completion = completions.get(command);
        return completion === undefined
          ? Effect.fail(backgroundTaskFailure(
              "unknown_task",
              `Missing controlled command ${command}`,
            ))
          : Deferred.succeed(completion, result);
      },
      start,
      stopCount: (command: string) =>
        Ref.get(stopCounts).pipe(
          Effect.map((counts) => counts.get(command) ?? 0),
        ),
    };
  });
}

function broker() {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-background-broker-",
    });
    const commands = yield* controlledCommands();
    const nextId = yield* Ref.make(0);
    const runtime = yield* BackgroundTaskBroker.make({
      rootDirectory,
      startCommand: commands.start,
      createId: () =>
        Ref.getAndUpdate(nextId, (value) => value + 1).pipe(
          Effect.map((value) => `bg-${value + 1}`),
        ),
      now: () => Effect.succeed(new Date("2026-08-01T00:00:00.000Z")),
    });
    return { commands, fileSystem, runtime };
  });
}

const request = (
  command: string,
  options: Partial<BackgroundCommandRequest> = {},
): BackgroundCommandRequest => ({
  command,
  description: `Run ${command}`,
  ...options,
});

describe("Effect background-task broker", () => {
  layer(platform)((it) => {
    it.effect("assigns stable IDs and publishes one terminal transition", () =>
      Effect.scoped(Effect.gen(function*() {
        const { commands, runtime } = yield* broker();
        const events = yield* Ref.make<Array<string>>([]);
        yield* runtime.onEvent((event) =>
          Ref.update(events, (current) => [...current, `${event.type}:${event.task.id}`])
        );

        const started = yield* runtime.start(request("alpha", {
          completionDelivery: "steer",
        }));
        assert.deepInclude(started, {
          id: "bg-1",
          state: "running",
          processId: 4242,
          completionDelivery: "steer",
        });
        yield* commands.complete("alpha", {
          state: "succeeded",
          summary: "done",
          exitCode: 0,
        });
        const finished = yield* runtime.get("bg-1", { waitMs: 100 });
        assert.deepInclude(finished, {
          state: "succeeded",
          completionObserved: true,
          exitCode: 0,
        });
        assert.deepStrictEqual(yield* Ref.get(events), [
          "task_started:bg-1",
          "task_terminal:bg-1",
        ]);
      })));

    it.effect("keeps file output pull-based and bounded", () =>
      Effect.scoped(Effect.gen(function*() {
        const { fileSystem, runtime } = yield* broker();
        const started = yield* runtime.start(request("output"));
        yield* fileSystem.writeFileString(started.outputPath, "0123456789");

        const snapshot = yield* runtime.get(started.id, { outputBytes: 4 });
        assert.deepInclude(snapshot, {
          outputBytes: 10,
          outputTail: "6789",
          outputTruncated: true,
        });
        assert.strictEqual((yield* runtime.list())[0]?.outputTail, "");
      })));

    it.effect("kills once and suppresses its terminal wake", () =>
      Effect.scoped(Effect.gen(function*() {
        const { commands, runtime } = yield* broker();
        const started = yield* runtime.start(request("kill"));
        const [first, second] = yield* Effect.all([
          runtime.kill(started.id),
          runtime.kill(started.id),
        ], { concurrency: "unbounded" });

        assert.deepInclude(first, {
          state: "cancelled",
          explicitlyKilled: true,
          completionObserved: true,
        });
        assert.deepStrictEqual(first, second);
        assert.strictEqual(yield* commands.stopCount("kill"), 1);
      })));

    it.effect("shutdown stops every running command without model wakes", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, runtime } = yield* broker();
        const first = yield* runtime.start(request("one"));
        const second = yield* runtime.start(request("two"));

        yield* runtime.shutdown;
        yield* runtime.shutdown;
        assert.strictEqual(yield* commands.stopCount("one"), 1);
        assert.strictEqual(yield* commands.stopCount("two"), 1);
        assert.deepInclude(yield* runtime.get(first.id), {
          completionObserved: true,
          state: "cancelled",
        });
        assert.deepInclude(yield* runtime.get(second.id), {
          completionObserved: true,
          state: "cancelled",
        });
      }))));
  });
});
