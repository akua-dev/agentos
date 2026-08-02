import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Deferred,
  Effect,
  FileSystem,
  Path,
  Ref,
  Schema,
} from "effect";

import { BackgroundTaskBroker } from "../../background-tasks/broker.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskTerminalResult,
} from "../../background-tasks/types.ts";
import { CoordinationReadinessState } from "../../readiness-state.ts";
import { makeCoordinationReadiness } from "../extension.ts";

const listenerCommand =
  "pg-listen agentos_mate_00000000000040008000000000000001";

function harness(taskId: string) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-coordination-",
    });
    const terminal = yield* Deferred.make<TaskTerminalResult>();
    const start: StartBackgroundCommand = () =>
      Effect.succeed({
        completion: Deferred.await(terminal),
        processId: 9001,
        stop: () => {
          const result: TaskTerminalResult = {
            state: "cancelled",
            summary: "Command killed",
          };
          return Deferred.succeed(terminal, result).pipe(
            Effect.as(result),
          );
        },
      });
    const broker = yield* BackgroundTaskBroker.make({
      createId: () => Effect.succeed(taskId),
      rootDirectory: paths.join(stateDirectory, "background"),
      startCommand: start,
    });
    const runtime = yield* makeCoordinationReadiness(broker, {
      agentName: "firstmate",
      herdrSession: "agentos-firstmate",
      ownerProcessId: 4242,
      stateDirectory,
    });
    yield* Effect.addFinalizer(() => runtime.shutdown);
    yield* Effect.addFinalizer(() => broker.shutdown);
    return {
      broker,
      complete: (result: TaskTerminalResult) => Deferred.succeed(terminal, result),
      fileSystem,
      readinessPath: paths.join(
        stateDirectory,
        "readiness",
        "coordination.json",
      ),
      runtime,
    };
  });
}

const safeListenerRequest: BackgroundCommandRequest = {
  command: listenerCommand,
  completionDelivery: "steer",
  description: "[agentos-supervision] wait for a durable current-Mate event",
  readyOutput: '"state":"listening"',
};

describe("Effect coordination semantic readiness", () => {
  layer(BunServices.layer)((it) => {
    it.effect("attests, confirms catch-up, and invalidates terminal work", () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* harness("bg-listener");
        yield* runtime.broker.start(safeListenerRequest);

        const attested = yield* runtime.runtime.attest({
          listener_task_id: "bg-listener",
        });
        assert.deepStrictEqual(attested.details, {
          listenerTaskId: "bg-listener",
          phase: "listening",
        });
        const listening = yield* runtime.fileSystem
          .readFileString(runtime.readinessPath)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(CoordinationReadinessState),
              ),
            ),
          );
        assert.deepStrictEqual(listening, {
          agentName: "firstmate",
          herdrSession: "agentos-firstmate",
          listenerProcessId: 9001,
          listenerTaskId: "bg-listener",
          ownerProcessId: 4242,
          phase: "listening",
          version: 1,
        });

        const caughtUp = yield* runtime.runtime.confirmCatchup({
          listener_task_id: "bg-listener",
        });
        assert.deepStrictEqual(caughtUp.details, {
          listenerTaskId: "bg-listener",
          phase: "caught_up",
        });
        yield* runtime.complete({
          exitCode: 0,
          state: "succeeded",
          summary: "Notification received",
        });
        yield* runtime.broker.get("bg-listener", { waitMs: 100 });
        assert.isFalse(yield* runtime.fileSystem.exists(runtime.readinessPath));
      })));

    it.effect("rejects a listener outside the exact native contract", () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* harness("bg-unsafe");
        yield* runtime.broker.start({
          ...safeListenerRequest,
          command: `${listenerCommand} && echo unsafe`,
        });

        const rejected = yield* Effect.result(runtime.runtime.attest({
          listener_task_id: "bg-unsafe",
        }));
        assert.strictEqual(rejected._tag, "Failure");
        if (rejected._tag === "Failure") {
          assert.deepInclude(rejected.failure, {
            code: "invalid_listener",
            message:
              "Background task does not satisfy the coordination listener contract",
          });
        }
        assert.isFalse(yield* runtime.fileSystem.exists(runtime.readinessPath));
      })));
  });
});
