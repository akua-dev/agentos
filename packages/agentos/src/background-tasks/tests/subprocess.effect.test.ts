import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { TestClock } from "effect/testing";

import { BoundedTaskOutput } from "../output.ts";
import { spawnTaskProcess } from "../subprocess.ts";

const platform = BunServices.layer;

function output(name: string, maxBytes = 1024 * 1024) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-subprocess-",
    });
    return yield* BoundedTaskOutput.open(path.join(directory, `${name}.log`), {
      tailBytes: 1_024,
      maxBytes,
    });
  });
}

describe("Effect background subprocess", () => {
  layer(platform)((it) => {
    it.effect("captures stdout and stderr through bounded output", () =>
      Effect.scoped(Effect.gen(function*() {
        const sink = yield* output("success");
        const handle = yield* spawnTaskProcess(
          "printf stdout; printf stderr >&2",
          { output: sink },
        );

        const result = yield* handle.completion;
        const snapshot = yield* sink.snapshot;
        assert.deepInclude(result, { exitCode: 0, signal: null });
        assert.include(snapshot.tail, "stdout");
        assert.include(snapshot.tail, "stderr");
      })));

    it.effect("recognizes a readiness marker split across chunks", () =>
      Effect.scoped(Effect.gen(function*() {
        const sink = yield* output("ready");
        const handle = yield* spawnTaskProcess(
          "printf rea >&2; sleep 0.02; printf dy >&2; sleep 0.02",
          { output: sink, readyOutput: "ready" },
        );

        assert.isTrue(yield* handle.readiness);
        assert.include((yield* sink.snapshot).tail, "ready");
        assert.deepInclude(yield* handle.completion, {
          exitCode: 0,
          signal: null,
        });
      })));

    it.effect("reports exit before the readiness marker", () =>
      Effect.scoped(Effect.gen(function*() {
        const sink = yield* output("not-ready");
        const handle = yield* spawnTaskProcess("printf booting", {
          output: sink,
          readyOutput: "ready",
        });

        assert.isFalse(yield* handle.readiness);
        assert.deepInclude(yield* handle.completion, {
          exitCode: 0,
          signal: null,
        });
      })));

    it.effect("shares one bounded TERM-to-KILL result across concurrent stops", () =>
      TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const sink = yield* output("stop");
        const handle = yield* spawnTaskProcess(
          "trap '' TERM; printf running; while :; do sleep 1; done",
          { output: sink, readyOutput: "running", terminateGraceMs: 20 },
        );

        assert.isTrue(yield* handle.readiness);
        const [first, second] = yield* Effect.all([
          handle.stop(),
          handle.stop(),
        ], { concurrency: "unbounded" });
        assert.deepStrictEqual(first, second);
        assert.isNull(first.exitCode);
        assert.strictEqual(first.signal, "SIGKILL");
        assert.include((yield* sink.snapshot).tail, "running");
      }))));

    it.effect("terminates a command that exceeds its file cap", () =>
      Effect.scoped(Effect.gen(function*() {
        const sink = yield* output("limit", 5);
        const handle = yield* spawnTaskProcess("printf 123456789", {
          output: sink,
        });

        assert.isTrue((yield* handle.completion).outputLimitReached);
        assert.strictEqual((yield* sink.snapshot).bytesWritten, 5);
      })));
  });
});
