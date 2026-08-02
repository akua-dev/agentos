import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { makeSemanticHealthRuntime } from "../health";

describe("Effect semantic health runtime", () => {
  layer(BunServices.layer)((it) => {
    it.effect("captures subprocess output and fails closed when launch fails", () =>
      Effect.gen(function*() {
        const runtime = yield* makeSemanticHealthRuntime;
        assert.deepStrictEqual(
          yield* runtime.run(["printf", "healthy"]),
          { exitCode: 0, stdout: "healthy" },
        );
        assert.deepStrictEqual(
          yield* runtime.run(["/agentos/command-that-does-not-exist"]),
          { exitCode: 1, stdout: "" },
        );
      }));

    it.effect("bounds and validates health probe file reads", () =>
      Effect.scoped(Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-health-",
        });
        const textPath = paths.join(directory, "state.json");
        const invalidPath = paths.join(directory, "invalid.txt");
        yield* fileSystem.writeFileString(textPath, "first\nsecond");
        yield* fileSystem.writeFile(invalidPath, new Uint8Array([0xff]));

        const runtime = yield* makeSemanticHealthRuntime;
        assert.strictEqual(yield* runtime.readText(textPath, 12), "first\nsecond");
        assert.isUndefined(yield* runtime.readText(textPath, 11));
        assert.strictEqual(yield* runtime.readFirstLine(textPath, 5), "first");
        assert.isUndefined(yield* runtime.readText(invalidPath, 1));
        assert.isUndefined(
          yield* runtime.readText(paths.join(directory, "missing"), 64),
        );
        assert.deepInclude(yield* runtime.metadata(textPath), {
          isFile: true,
          size: 12,
        });
      })));
  });
});
