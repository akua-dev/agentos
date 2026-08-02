import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Result,
} from "effect";
import { TestClock } from "effect/testing";

import { startBackgroundCommand } from "../command.ts";
import { BackgroundTaskError } from "../types.ts";

const platform = BunServices.layer;

const context = (outputPath: string, cancellation: Effect.Effect<void>) => ({
  outputPath,
  tailBytes: 1_024,
  maxOutputBytes: 1_024 * 1_024,
  terminateGraceMs: 20,
  cancellation,
});

function temporaryOutputPath() {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-command-",
    });
    return path.join(directory, "output.log");
  });
}

describe("Effect background command lifecycle", () => {
  layer(platform)((it) => {
    it.effect("does not report a start before literal readiness", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const outputPath = yield* temporaryOutputPath();
        const starting = yield* startBackgroundCommand({
          command:
            "printf booting; sleep 0.05; printf listening >&2; sleep 0.02",
          description: "Wait until the listener is registered",
          readyOutput: "listening",
          readyTimeout: 500,
        }, context(outputPath, Effect.never)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        assert.isTrue(Option.isNone(
          yield* Fiber.join(starting).pipe(Effect.timeoutOption(20)),
        ));
        const handle = yield* Fiber.join(starting);
        assert.deepInclude(yield* handle.completion, {
          state: "succeeded",
          exitCode: 0,
        });
      }))));

    it.effect("fails startup with a typed readiness timeout and stops the process", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const outputPath = yield* temporaryOutputPath();
        const started = yield* Effect.result(startBackgroundCommand({
          command: "sleep 0.1",
          description: "Wait for missing readiness output",
          readyOutput: "listening",
          readyTimeout: 20,
        }, context(outputPath, Effect.never)));

        assert.isTrue(Result.isFailure(started));
        if (Result.isFailure(started)) {
          assert.instanceOf(started.failure, BackgroundTaskError);
          assert.strictEqual(started.failure.code, "readiness_timeout");
        }
      }))));

    it.effect("keeps an unmarked command deadline as ordinary failure", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const outputPath = yield* temporaryOutputPath();
        const handle = yield* startBackgroundCommand({
          command: "sleep 10",
          description: "Run a bounded command",
          timeout: 20,
        }, context(outputPath, Effect.never));

        assert.deepInclude(yield* handle.completion, {
          state: "failed",
          summary: "Background command timed out",
          error: "Command exceeded 20ms",
        });
      }))));

    it.effect("maps explicit cancellation to a stable cancelled result", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const outputPath = yield* temporaryOutputPath();
        const cancellation = yield* Deferred.make<void>();
        const handle = yield* startBackgroundCommand({
          command: "sleep 10",
          description: "Wait until cancelled",
        }, context(outputPath, Deferred.await(cancellation)));

        yield* Deferred.succeed(cancellation, undefined);
        const first = yield* handle.completion;
        const second = yield* handle.completion;
        assert.deepStrictEqual(first, second);
        assert.deepInclude(first, {
          state: "cancelled",
          summary: "Background command killed",
        });
      }))));
  });
});
