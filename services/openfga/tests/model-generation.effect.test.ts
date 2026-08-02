import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

describe("OpenFGA model generation", () => {
  it.effect("keeps the generated authorization model synchronized", () =>
    Effect.scoped(Effect.gen(function*() {
      const paths = yield* Path.Path;
      const serviceRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const child = yield* ChildProcess.make("bun", [
        "scripts/generate-model.ts",
        "--check",
      ], {
        cwd: serviceRoot,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.runDrain),
      ], { concurrency: "unbounded" });
      assert.strictEqual(exitCode, 0, stderr);
    })).pipe(Effect.provide(BunServices.layer)));
});
