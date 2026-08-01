import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("..", import.meta.url));

describe("AI Gateway host boundary", () => {
  it.effect("uses one Effect Platform Bun entrypoint and no Promise runtime bridge", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fileSystem.readFileString(
        path.join(serviceRoot, "src/main.ts"),
      );
      assert.include(source, "BunHttpServer.layer");
      assert.include(source, "HttpRouter.serve");
      assert.match(source, /Layer\.build\(\s*makeAIRoutingStateLive/);
      assert.include(source, "Context.get(routingContext, AIRoutingState)");
      assert.notInclude(source, "AIRoutingState.pipe(");
      assert.strictEqual(source.match(/BunRuntime\.runMain/g)?.length, 1);
      for (const forbidden of [
        "Bun.serve",
        "ManagedRuntime",
        "runPromise",
        "async ",
        "new Promise",
        "process.env",
        "process.argv",
      ]) {
        assert.notInclude(source, forbidden);
      }
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ));
});
