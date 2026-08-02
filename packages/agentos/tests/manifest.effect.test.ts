import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { AgentOSPackageManifest } from "./manifest-contract.ts";

const readManifest = Effect.fn("test.agentosManifest.read")(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const packageJson = yield* paths.fromFileUrl(
    new URL("../package.json", import.meta.url),
  );
  const source = yield* fileSystem.readFileString(packageJson);
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AgentOSPackageManifest),
  )(source);
});

describe("@akua-dev/agentos Pi manifest", () => {
  it.effect("is the only public package workspace", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const packagesDirectory = yield* paths.fromFileUrl(
        new URL("../../", import.meta.url),
      );
      const entries = yield* fileSystem.readDirectory(packagesDirectory);
      const inspected = yield* Effect.forEach(
        entries,
        (name) => fileSystem.stat(paths.join(packagesDirectory, name)).pipe(
          Effect.map((info) => ({ info, name })),
        ),
        { concurrency: "unbounded" },
      );
      const directories = inspected
        .filter((entry) => entry.info.type === "Directory")
        .map((entry) => entry.name)
        .sort();

      assert.deepStrictEqual(directories, ["agentos"]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("publishes one root API with one extension entrypoint and one Skill root", () =>
    Effect.gen(function*() {
      const manifest = yield* readManifest();
      assert.strictEqual(manifest.name, "@akua-dev/agentos");
      assert.deepStrictEqual(manifest.exports, {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      });
      assert.notProperty(manifest.dependencies, manifest.name);
      assert.include(manifest.keywords, "pi-package");
      assert.deepStrictEqual(manifest.pi, {
        extensions: ["./extensions/agentos.ts"],
        skills: ["./skills"],
      });
      assert.isUndefined(manifest.pi.prompts);
    }).pipe(Effect.provide(BunServices.layer)));
});
