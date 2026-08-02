import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { buildAgentOS } from "../build.ts";

describe("AgentOS package build", () => {
  it.effect("compiles through the reviewed Effect build without mutating shared dist", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-build-contract-",
      });
      const outputDirectory = paths.join(sandbox, "dist");

      yield* buildAgentOS({ outputDirectory });

      assert.isTrue(
        yield* fileSystem.exists(paths.join(outputDirectory, "index.js")),
      );
    })).pipe(Effect.provide(BunServices.layer)));
});
