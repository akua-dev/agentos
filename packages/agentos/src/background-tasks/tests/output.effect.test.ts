import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";

import {
  BoundedTaskOutput,
  TaskOutputError,
} from "../output.ts";

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

describe("Effect bounded background-task output", () => {
  layer(platform)((it) => {
    it.effect("serializes writes and retains only the configured tail", () =>
      Effect.scoped(Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-background-output-",
        });
        const outputPath = path.join(directory, "task.log");
        const output = yield* BoundedTaskOutput.open(outputPath, {
          tailBytes: 5,
          maxBytes: 64,
        });

        yield* output.write(new TextEncoder().encode("abc"));
        yield* output.write(new TextEncoder().encode("def"));
        const snapshot = yield* output.snapshot;
        yield* output.close;

        assert.strictEqual(
          yield* fileSystem.readFileString(outputPath),
          "abcdef",
        );
        assert.deepStrictEqual(snapshot, {
          bytesWritten: 6,
          tail: "bcdef",
          truncated: true,
          limitReached: false,
        });
      })));

    it.effect("fails with a typed limit error before writing overflow bytes", () =>
      Effect.scoped(Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-background-output-",
        });
        const outputPath = path.join(directory, "task.log");
        const output = yield* BoundedTaskOutput.open(outputPath, {
          maxBytes: 4,
        });

        const write = yield* Effect.result(
          output.write(new TextEncoder().encode("abcdef")),
        );
        assert.isTrue(Result.isFailure(write));
        if (Result.isFailure(write)) {
          assert.instanceOf(write.failure, TaskOutputError);
          assert.strictEqual(write.failure.code, "output_limit_reached");
        }
        assert.strictEqual(yield* fileSystem.readFileString(outputPath), "abcd");
        assert.deepStrictEqual(yield* output.snapshot, {
          bytesWritten: 4,
          tail: "abcd",
          truncated: false,
          limitReached: true,
        });
        yield* output.close;
      })));
  });
});
