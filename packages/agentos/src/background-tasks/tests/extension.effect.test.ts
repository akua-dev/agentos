import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Ref,
} from "effect";
import { TestClock } from "effect/testing";

import {
  makeAgentosBackgroundTasks,
  type AgentOSBackgroundTasksHost,
  type BackgroundTaskCompletion,
} from "../extension.ts";
import {
  TASK_LIFECYCLE_ENTRY,
  type TaskLifecycleEntry,
} from "../lifecycle.ts";
import { backgroundTaskFailure } from "../types.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskTerminalResult,
} from "../types.ts";

function controlledCommands() {
  return Effect.gen(function*() {
    const completions = yield* Ref.make(
      new Map<string, Deferred.Deferred<TaskTerminalResult>>(),
    );
    const requests = yield* Ref.make<ReadonlyArray<BackgroundCommandRequest>>([]);
    const stopCounts = yield* Ref.make(new Map<string, number>());
    const start: StartBackgroundCommand = (request) =>
      Effect.gen(function*() {
        const completion = yield* Deferred.make<TaskTerminalResult>();
        yield* Ref.update(completions, (current) =>
          new Map(current).set(request.command, completion));
        yield* Ref.update(requests, (current) => [...current, request]);
        return {
          completion: Deferred.await(completion),
          processId: 4242,
          stop: () => Effect.gen(function*() {
            yield* Ref.update(stopCounts, (current) => {
              const next = new Map(current);
              next.set(request.command, (next.get(request.command) ?? 0) + 1);
              return next;
            });
            const terminal: TaskTerminalResult = {
              state: "cancelled",
              summary: "Command killed",
            };
            yield* Deferred.succeed(completion, terminal);
            return terminal;
          }),
        };
      });
    return {
      complete: (command: string, terminal: TaskTerminalResult) =>
        Ref.get(completions).pipe(
          Effect.flatMap((current) => {
            const completion = current.get(command);
            return completion === undefined
              ? Effect.fail(backgroundTaskFailure(
                  "unknown_task",
                  `Missing controlled command ${command}`,
                ))
              : Deferred.succeed(completion, terminal);
          }),
        ),
      requests: Ref.get(requests),
      start,
      stopCount: (command: string) =>
        Ref.get(stopCounts).pipe(
          Effect.map((current) => current.get(command) ?? 0),
        ),
    };
  });
}

function testHost() {
  return Effect.gen(function*() {
    const completions = yield* Ref.make<ReadonlyArray<BackgroundTaskCompletion>>([]);
    const entries = yield* Ref.make<ReadonlyArray<TaskLifecycleEntry>>([]);
    const host: AgentOSBackgroundTasksHost = {
      appendLifecycle: (entry) =>
        Ref.update(entries, (current) => [...current, entry]),
      sendCompletion: (completion) =>
        Ref.update(completions, (current) => [...current, completion]),
    };
    return {
      completions: Ref.get(completions),
      entries: Ref.get(entries),
      host,
    };
  });
}

function harness(
  prefix = "agentos-background-extension-",
  batchDelayMs = 10,
) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const commands = yield* controlledCommands();
    const observed = yield* testHost();
    const nextId = yield* Ref.make(0);
    const runtime = yield* makeAgentosBackgroundTasks(observed.host, {
      batchDelayMs,
      createId: () =>
        Ref.getAndUpdate(nextId, (value) => value + 1).pipe(
          Effect.map((value) => `bg-${value + 1}`),
        ),
      rootDirectory,
      startCommand: commands.start,
    });
    yield* Effect.addFinalizer(() => runtime.shutdown);
    return { commands, fileSystem, observed, runtime };
  });
}

describe("Effect background-task extension runtime", () => {
  layer(BunServices.layer)((it) => {
    it.effect("validates inputs and forwards the typed command contract", () =>
      Effect.scoped(Effect.gen(function*() {
        const { commands, runtime } = yield* harness();
        const rejected = yield* Effect.result(runtime.run({
          command: "worker",
          description: "Worker",
          ready_timeout: 50,
        }));
        assert.strictEqual(rejected._tag, "Failure");

        const started = yield* runtime.run({
          command: "worker",
          completion_delivery: "steer",
          description: "Worker",
          ready_output: "ready",
          ready_timeout: 50,
        });
        assert.deepInclude(started.details, {
          completionDelivery: "steer",
          id: "bg-1",
          state: "running",
        });
        assert.deepStrictEqual(yield* commands.requests, [{
          command: "worker",
          completionDelivery: "steer",
          description: "Worker",
          readyOutput: "ready",
          readyTimeout: 50,
        }]);
      })));

    it.effect("keeps output pull-based and exposes bounded list pages", () =>
      Effect.scoped(Effect.gen(function*() {
        const { fileSystem, runtime } = yield* harness();
        const first = yield* runtime.run({ command: "one", description: "One" });
        yield* fileSystem.writeFileString(first.details.outputPath, "0123456789");

        const output = yield* runtime.output({
          output_bytes: 4,
          task_id: first.details.id,
        });
        assert.deepInclude(output.details, {
          outputBytes: 10,
          outputTail: "6789",
          outputTruncated: true,
        });
        const running = yield* runtime.list({});
        assert.deepStrictEqual(
          running.details.tasks.map(({ id }) => id),
          ["bg-1"],
        );
      })));

    it.effect("orders terminal history and follows its bounded cursor", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, runtime } = yield* harness();
        for (const command of ["one", "two", "three"]) {
          const started = yield* runtime.run({
            command,
            description: command,
          });
          yield* commands.complete(command, {
            exitCode: 0,
            state: "succeeded",
            summary: "done",
          });
          yield* runtime.output({
            task_id: started.details.id,
            timeout_ms: 1_000,
          });
          yield* Effect.sleep("2 millis");
        }

        const firstPage = yield* runtime.list({
          limit: 2,
          state: "terminal",
        });
        assert.deepStrictEqual(
          firstPage.details.tasks.map(({ id }) => id),
          ["bg-3", "bg-2"],
        );
        assert.strictEqual(firstPage.details.nextCursor, "bg-2");
        const secondPage = yield* runtime.list({
          before_task_id: firstPage.details.nextCursor,
          limit: 2,
          state: "terminal",
        });
        assert.deepStrictEqual(
          secondPage.details.tasks.map(({ id }) => id),
          ["bg-1"],
        );
      }))));

    it.effect("batches natural completions by delivery policy", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, observed, runtime } = yield* harness();
        yield* runtime.run({
          command: "steer",
          completion_delivery: "steer",
          description: "Steer",
        });
        yield* runtime.run({
          command: "follow",
          description: "Follow",
        });
        yield* commands.complete("steer", {
          exitCode: 0,
          state: "succeeded",
          summary: "done",
        });
        yield* commands.complete("follow", {
          exitCode: 0,
          state: "succeeded",
          summary: "done",
        });
        yield* Effect.yieldNow;
        yield* Effect.sleep("20 millis");

        const completions = yield* observed.completions;
        assert.deepStrictEqual(
          completions.map(({ deliverAs, taskIds }) => ({ deliverAs, taskIds })),
          [
            { deliverAs: "steer", taskIds: ["bg-1"] },
            { deliverAs: "followUp", taskIds: ["bg-2"] },
          ],
        );
      }))));

    it.effect("suppresses completion delivery for an explicit kill", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, observed, runtime } = yield* harness();
        const started = yield* runtime.run({ command: "kill", description: "Kill" });
        const killed = yield* runtime.kill({ task_id: started.details.id });
        yield* Effect.sleep("20 millis");

        assert.deepInclude(killed.details, {
          completionObserved: true,
          explicitlyKilled: true,
          state: "cancelled",
        });
        assert.strictEqual(yield* commands.stopCount("kill"), 1);
        assert.deepStrictEqual(yield* observed.completions, []);
      }))));

    it.effect("consumes completion through a blocking output read without a wake", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, observed, runtime } = yield* harness(
          "agentos-background-blocking-",
          50,
        );
        const started = yield* runtime.run({ command: "wait", description: "Wait" });
        const reading = yield* runtime.output({
          task_id: started.details.id,
          timeout_ms: 1_000,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* commands.complete("wait", {
          exitCode: 0,
          state: "succeeded",
          summary: "done",
        });
        const output = yield* Fiber.join(reading);
        yield* Effect.sleep("75 millis");

        assert.isTrue(output.details.completionObserved);
        assert.deepStrictEqual(yield* observed.completions, []);
      }))));

    it.effect("lets an output read consume a queued completion before delivery", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const { commands, observed, runtime } = yield* harness(
          "agentos-background-observed-",
          50,
        );
        const started = yield* runtime.run({
          command: "quick",
          description: "Quick",
        });
        const terminalEvent = yield* Deferred.make<void>();
        const unsubscribe = yield* runtime.broker.onEvent((event) =>
          event.type === "task_terminal" && event.task.id === started.details.id
            ? Deferred.succeed(terminalEvent, undefined).pipe(Effect.asVoid)
            : Effect.void
        );
        yield* Effect.addFinalizer(() => unsubscribe);
        yield* commands.complete("quick", {
          exitCode: 0,
          state: "succeeded",
          summary: "done",
        });
        yield* Deferred.await(terminalEvent);
        const output = yield* runtime.output({ task_id: started.details.id });
        yield* Effect.sleep("75 millis");

        assert.isTrue(output.details.completionObserved);
        assert.deepStrictEqual(yield* observed.completions, []);
      }))));

    it.effect("checkpoints and restores unfinished work as interrupted", () =>
      Effect.scoped(Effect.gen(function*() {
        const first = yield* harness("agentos-background-first-");
        const started = yield* first.runtime.run({
          command: "persistent",
          description: "Persistent",
        });
        yield* first.runtime.sessionTree;
        const checkpoint = (yield* first.observed.entries).at(-1);
        assert.isDefined(checkpoint);

        const second = yield* harness("agentos-background-second-");
        yield* second.runtime.sessionStart([{
          customType: TASK_LIFECYCLE_ENTRY,
          data: checkpoint,
          type: "custom",
        }]);
        assert.deepInclude(yield* second.runtime.broker.get(started.details.id), {
          completionObserved: true,
          state: "interrupted",
        });
        const restoredEntry = (yield* second.observed.entries).at(-1);
        assert.isDefined(restoredEntry);
        assert.deepInclude(restoredEntry.task, {
          id: started.details.id,
          state: "interrupted",
        });
      })));
  });
});
