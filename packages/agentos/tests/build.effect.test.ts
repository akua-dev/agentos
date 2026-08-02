import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

describe("AgentOS package build", () => {
  it.effect("compiles through the reviewed Effect build entrypoint", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const packageRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const child = yield* ChildProcess.make("bun", ["build.ts"], {
        cwd: packageRoot,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.runDrain),
      ], { concurrency: "unbounded" });
      assert.strictEqual(exitCode, 0, stderr);
      assert.isTrue(yield* fileSystem.exists(paths.join(packageRoot, "dist", "index.js")));
    })).pipe(Effect.provide(BunServices.layer)));
});
