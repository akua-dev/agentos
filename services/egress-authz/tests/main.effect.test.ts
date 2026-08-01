import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("egress authorizer host boundary", () => {
  it.effect("uses one Effect Platform Bun entrypoint and no Promise runtime bridge", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fileSystem.readFileString(
        path.join(serviceRoot, "src/main.ts"),
      );
      assert.strictEqual(source.includes("BunHttpServer.layer"), true);
      assert.strictEqual(source.includes("HttpRouter.serve"), true);
      assert.strictEqual(
        source.match(/BunRuntime\.runMain/g)?.length,
        1,
      );
      for (const forbidden of [
        "Bun.serve",
        "ManagedRuntime",
        "runPromise",
        "async ",
        "new Promise",
      ]) {
        assert.strictEqual(source.includes(forbidden), false);
      }
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ));

  it.effect("ships the entrypoint and production dependencies in the AgentOS image", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dockerfile = yield* fileSystem.readFileString(
        path.join(repositoryRoot, "Dockerfile"),
      );
      assert.include(
        dockerfile,
        "COPY services/egress-authz/package.json services/egress-authz/package.json",
      );
      assert.include(dockerfile, "--filter @agentos/egress-authz");
      assert.include(
        dockerfile,
        "/opt/agentos/services/egress-authz/src/main.ts",
      );
      assert.include(dockerfile, "/usr/local/bin/agentos-egress-authz");
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ));
});
