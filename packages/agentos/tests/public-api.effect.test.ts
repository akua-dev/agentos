import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { AgentOSPackageManifest } from "./manifest-contract.ts";
import { runTestProcess } from "./test-process.ts";

describe("@akua-dev/agentos public package", () => {
  it.effect("uses the one public AgentOS package name", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const packageJson = yield* paths.fromFileUrl(
        new URL("../package.json", import.meta.url),
      );
      const manifest = yield* fileSystem.readFileString(packageJson).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(
          Schema.fromJsonString(AgentOSPackageManifest),
        )),
      );

      assert.strictEqual(manifest.name, "@akua-dev/agentos");
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("typechecks an external extension using documented exports only", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const testsDirectory = yield* paths.fromFileUrl(
        new URL(".", import.meta.url),
      );
      const fixture = paths.join(
        testsDirectory,
        "fixtures",
        "external-extension",
        "index.ts",
      );
      const executable = paths.resolve(
        testsDirectory,
        "../../../node_modules/.bin/tsc",
      );
      const result = yield* runTestProcess(executable, [
        "--ignoreConfig",
        "--allowImportingTsExtensions",
        "--module",
        "Preserve",
        "--moduleResolution",
        "bundler",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ESNext",
        fixture,
      ]);
      assert.deepStrictEqual(result, {
        exitCode: 0,
        stderr: "",
        stdout: "",
      });
    }).pipe(Effect.provide(BunServices.layer)));
});
