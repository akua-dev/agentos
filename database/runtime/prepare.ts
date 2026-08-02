#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Config,
  ConfigProvider,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

export type PrepareOptions = {
  readonly dataDirectory?: string;
  readonly releaseRoot?: string;
};

const PrepareOperationSchema = Schema.Literals([
  "collect_release_files",
  "hash_release",
  "prepare_directory",
  "copy_release_file",
  "install_dependencies",
  "publish_workspace",
]);

export class PrepareMigrationWorkspaceError extends Schema.TaggedErrorClass<PrepareMigrationWorkspaceError>()(
  "PrepareMigrationWorkspaceError",
  {
    operation: PrepareOperationSchema,
    path: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

const RootPackageSchema = Schema.fromJsonString(Schema.Struct({
  workspaces: Schema.optional(Schema.Array(Schema.String)),
}));

const environment = Config.all({
  home: Config.option(Config.string("HOME")),
  implementationRoot: Config.option(
    Config.string("AGENTOS_IMPLEMENTATION_ROOT"),
  ),
});

const requiredDatabaseFiles = [
  "database/AGENTS.md",
  "database/README.md",
  "database/package.json",
  "database/drizzle.config.ts",
  "database/drizzle.tooling.ts",
  "database/runtime/database-credentials.ts",
  "database/runtime/drizzle-config.ts",
  "database/runtime/drizzle.ts",
  "database/runtime/prepare.ts",
  "database/sql.d.ts",
] satisfies ReadonlyArray<string>;

export const prepareMigrationWorkspace = Effect.fn(
  "agentos.database.prepareMigrationWorkspace",
)(function*(options: PrepareOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const configured = yield* environment;
  const defaultReleaseRoot = yield* paths.fromFileUrl(
    new URL("../..", import.meta.url),
  ).pipe(
    Effect.mapError(failure("collect_release_files")),
  );
  const releaseRoot = options.releaseRoot ??
    Option.getOrElse(configured.implementationRoot, () => defaultReleaseRoot);
  const home = Option.getOrElse(configured.home, () => ".");
  const dataDirectory = options.dataDirectory ?? paths.join(
    home,
    ".local",
    "share",
    "agentos",
    "database",
  );

  const files = yield* releaseFiles(releaseRoot).pipe(
    Effect.mapError(failure("collect_release_files", releaseRoot)),
  );
  const releaseKey = yield* releaseDigest(releaseRoot, files).pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.mapError(failure("hash_release", releaseRoot)),
  );
  const targetRoot = paths.join(dataDirectory, releaseKey);
  const targetPackage = paths.join(targetRoot, "database");
  const readyFile = paths.join(targetRoot, ".ready");
  if (yield* fileSystem.exists(readyFile).pipe(
    Effect.mapError(failure("prepare_directory", readyFile)),
  )) return targetPackage;

  yield* fileSystem.makeDirectory(dataDirectory, {
    recursive: true,
    mode: 0o700,
  }).pipe(Effect.mapError(failure("prepare_directory", dataDirectory)));

  if (yield* fileSystem.exists(targetRoot).pipe(
    Effect.mapError(failure("prepare_directory", targetRoot)),
  )) {
    yield* fileSystem.remove(targetRoot, { force: true, recursive: true }).pipe(
      Effect.mapError(failure("prepare_directory", targetRoot)),
    );
  }

  const stagingRoot = yield* fileSystem.makeTempDirectory({
    directory: dataDirectory,
    prefix: `.${releaseKey}-`,
  }).pipe(Effect.mapError(failure("prepare_directory", dataDirectory)));

  yield* Effect.gen(function*() {
    yield* Effect.forEach(files, (relativePath) => {
      const source = paths.join(releaseRoot, relativePath);
      const destination = paths.join(stagingRoot, relativePath);
      return fileSystem.makeDirectory(paths.dirname(destination), {
        recursive: true,
      }).pipe(
        Effect.andThen(fileSystem.copyFile(source, destination)),
        Effect.mapError(failure("copy_release_file", relativePath)),
      );
    }, { discard: true });

    yield* installDependencies(stagingRoot);
    yield* fileSystem.writeFileString(
      paths.join(stagingRoot, ".ready"),
      `${releaseKey}\n`,
      { mode: 0o600 },
    ).pipe(
      Effect.mapError(failure("publish_workspace", stagingRoot)),
    );

    yield* fileSystem.rename(stagingRoot, targetRoot).pipe(
      Effect.catch((cause) =>
        fileSystem.exists(readyFile).pipe(
          Effect.mapError(failure("publish_workspace", targetRoot)),
          Effect.flatMap((published) =>
            published
              ? Effect.void
              : Effect.fail(new PrepareMigrationWorkspaceError({
                operation: "publish_workspace",
                path: targetRoot,
                cause,
              }))
          ),
        )
      ),
    );
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(stagingRoot, { force: true, recursive: true }).pipe(
        Effect.ignore,
      ),
    ),
  );

  return targetPackage;
});

const releaseFiles = Effect.fn("agentos.database.releaseFiles")(
  function*(releaseRoot: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const rootPackagePath = paths.join(releaseRoot, "package.json");
    const rootPackage = yield* fileSystem.readFileString(rootPackagePath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RootPackageSchema)),
    );
    const workspaceFiles = yield* Effect.forEach(
      rootPackage.workspaces ?? [],
      (workspace) =>
        fileSystem.glob(`${workspace}/package.json`, { root: releaseRoot }),
      { concurrency: "unbounded" },
    );
    const migrationCandidates = yield* fileSystem.glob(
      "database/migrations/**/*",
      { root: releaseRoot },
    );
    const migrationFiles = yield* Effect.filter(
      migrationCandidates,
      (relativePath) =>
        fileSystem.stat(paths.join(releaseRoot, relativePath)).pipe(
          Effect.map((info) => info.type === "File"),
        ),
      { concurrency: "unbounded" },
    );
    return [...new Set([
      "bun.lock",
      "bunfig.toml",
      "package.json",
      ...workspaceFiles.flat(),
      ...requiredDatabaseFiles,
      ...migrationFiles,
    ])].sort();
  },
);

const releaseDigest = Effect.fn("agentos.database.releaseDigest")(
  function*(releaseRoot: string, files: ReadonlyArray<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const encoder = new TextEncoder();
    const chunks = yield* Effect.forEach(files, (relativePath) =>
      Effect.gen(function*() {
        const contents = yield* fileSystem.readFile(
          paths.join(releaseRoot, relativePath),
        );
        const header = encoder.encode(
          `${relativePath.length}:${relativePath}:${contents.length}:`,
        );
        return { contents, header };
      }));
    const flattened = chunks.flatMap(({ contents, header }) => [
      header,
      contents,
    ]);
    const payload = new Uint8Array(
      flattened.reduce((size, chunk) => size + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of flattened) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = yield* crypto.digest("SHA-256", payload);
    return Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  },
);

const installDependencies = Effect.fn("agentos.database.installDependencies")(
  function*(stagingRoot: string) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make("bun", [
        "install",
        "--frozen-lockfile",
        "--production",
        "--filter",
        "@agentos/database",
        "--no-progress",
      ], {
        cwd: stagingRoot,
        stderr: "pipe",
        stdout: "pipe",
      }).pipe(
        Effect.mapError(failure("install_dependencies", stagingRoot)),
      );
      const [exitCode, stderr] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.runDrain),
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError(failure("install_dependencies", stagingRoot)),
      );
      if (exitCode !== 0) {
        return yield* new PrepareMigrationWorkspaceError({
          operation: "install_dependencies",
          path: stagingRoot,
          exitCode,
          cause: stderr.trim() || undefined,
        });
      }
    }));
  },
);

function failure(
  operation: typeof PrepareOperationSchema.Type,
  path?: string,
) {
  return (cause: unknown) => new PrepareMigrationWorkspaceError({
    operation,
    path,
    cause,
  });
}

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const prepared = yield* prepareMigrationWorkspace();
  yield* Stream.make(`${prepared}\n`).pipe(Stream.run(stdio.stdout()));
});

if (import.meta.main) {
  const live = Layer.mergeAll(
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(main.pipe(Effect.provide(live)), {
    disableErrorReporting: true,
  });
}
