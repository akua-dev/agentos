import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("A2A service host boundary", () => {
  it.effect("uses exactly one Effect Platform Bun runtime boundary", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fileSystem.readFileString(
        path.join(serviceRoot, "src/main.ts"),
      );
      assert.include(source, "BunHttpServer.layer");
      assert.include(source, "HttpRouter.serve");
      assert.strictEqual(source.match(/BunRuntime\.runMain/g)?.length, 1);
      for (const forbidden of [
        "Bun.serve",
        "ManagedRuntime",
        "runPromise",
        "async ",
        "new Promise",
        "process.env",
        "Bun.env",
        "JSON.stringify",
      ]) {
        assert.notInclude(source, forbidden);
      }
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ));

  it.effect("ships the A2A entrypoint and production dependencies in the image", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dockerfile = yield* fileSystem.readFileString(
        path.join(repositoryRoot, "Dockerfile"),
      );
      assert.include(
        dockerfile,
        "COPY services/a2a/package.json services/a2a/package.json",
      );
      assert.include(dockerfile, "--filter @agentos/a2a");
      assert.include(dockerfile, "/opt/agentos/services/a2a/src/main.ts");
      assert.include(dockerfile, "/usr/local/bin/agentos-a2a");
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ));
});
