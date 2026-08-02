import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Path,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

import { prepareMigrationWorkspace } from "../runtime/prepare.ts";

function environment(values: Readonly<Record<string, string>>) {
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...values } }));
}

const run = Effect.fn("test.databaseRuntime.run")(function*(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* ChildProcess.make(command, args, {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

describe("database migration runtime", () => {
  it.effect("prepares a reusable migration workspace outside the release image", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const releaseRoot = yield* paths.fromFileUrl(
        new URL("../..", import.meta.url),
      );
      const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-database-runtime-",
      });

      const first = yield* prepareMigrationWorkspace({
        dataDirectory,
        releaseRoot,
      });
      const second = yield* prepareMigrationWorkspace({
        dataDirectory,
        releaseRoot,
      });

      assert.strictEqual(second, first);
      assert.strictEqual(
        yield* fileSystem.readFileString(paths.join(first, "AGENTS.md")),
        yield* fileSystem.readFileString(
          paths.join(releaseRoot, "database", "AGENTS.md"),
        ),
      );
      const result = yield* run("bun", ["run", "migration:check"], first);
      assert.strictEqual(result.exitCode, 0, result.stderr || result.stdout);
    }).pipe(Effect.provide(BunServices.layer))), 120_000);

  it.effect("keeps database tooling rooted in the implementation directory", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const releaseRoot = yield* paths.fromFileUrl(
        new URL("../..", import.meta.url),
      );
      const dataDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-database-runtime-",
      });
      const prepared = yield* prepareMigrationWorkspace({ dataDirectory }).pipe(
        Effect.provide(environment({
          AGENTOS_RELEASE_ROOT: paths.join(
            releaseRoot,
            "missing-repository-root",
          ),
        })),
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(paths.join(prepared, "package.json")),
        yield* fileSystem.readFileString(
          paths.join(releaseRoot, "database", "package.json"),
        ),
      );
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("keeps one reviewed Effect runtime adapter for the Drizzle executable", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const sourcePath = yield* paths.fromFileUrl(
        new URL("../runtime/drizzle.ts", import.meta.url),
      );
      const source = yield* fileSystem.readFileString(sourcePath);
      assert.strictEqual(
        (source.match(/BunRuntime\.runMain/g) ?? []).length,
        1,
      );
      assert.include(
        source,
        'from "@effect/platform-bun/BunRuntime"',
      );
      assert.notInclude(source, "process.env");
      assert.notInclude(source, "Effect.runPromise");
    }).pipe(Effect.provide(BunServices.layer)));
});
