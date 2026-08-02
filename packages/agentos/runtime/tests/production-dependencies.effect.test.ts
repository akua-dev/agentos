import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const RootPackage = Schema.Struct({
  workspaces: Schema.Array(Schema.String),
});
const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const run = Effect.fn("test.productionDependencies.run")(function*(
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  },
) {
  const command = ChildProcess.make(executable, args, {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...options.env },
    extendEnv: options.env === undefined,
    stderr: "pipe",
    stdout: "pipe",
  });
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* command;
    const [exitCode, stdout, stderr] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout } satisfies CommandResult;
  }));
});

const readRootPackage = Effect.fn("test.productionDependencies.readRootPackage")(
  function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const source = yield* fileSystem.readFileString(
      paths.join(repository, "package.json"),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(RootPackage),
    )(source);
  },
);

const copyProductionInstallInputs = Effect.fn(
  "test.productionDependencies.copyInstallInputs",
)(function*(destination: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const rootPackage = yield* readRootPackage();
  const files = [
    "package.json",
    "bun.lock",
    "clis/github-app-token/package.json",
    "clis/github-app-token/github-app-token.ts",
    "clis/pg-listen/package.json",
    "clis/pg-listen/pg-listen.ts",
    "database/package.json",
    "packages/agentos/package.json",
    "services/a2a/package.json",
    "services/agentgateway/package.json",
    "services/ai-gateway/package.json",
    "services/egress-authz/package.json",
    "services/github-broker/package.json",
    "services/openfga/package.json",
    "services/otel-collector/package.json",
    ...(rootPackage.workspaces.includes("website/apps/docs")
      ? ["website/apps/docs/package.json"]
      : []),
  ];
  yield* Effect.forEach(files, (file) => {
    const output = paths.join(destination, file);
    return fileSystem.makeDirectory(paths.dirname(output), {
      recursive: true,
    }).pipe(
      Effect.andThen(fileSystem.copyFile(paths.join(repository, file), output)),
    );
  });
});

const declaredWorkspaceManifests = Effect.fn(
  "test.productionDependencies.declaredWorkspaceManifests",
)(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const rootPackage = yield* readRootPackage();
  const manifests = yield* Effect.forEach(
    rootPackage.workspaces,
    (workspace) =>
      fileSystem.glob(`${workspace}/package.json`, { root: repository }),
    { concurrency: "unbounded" },
  );
  return [...new Set(manifests.flat())].sort();
});

describe("production dependency image", () => {
  it.effect("includes every Bun workspace manifest in each Docker install stage", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const dockerfile = yield* fileSystem.readFileString(
        paths.join(repository, "Dockerfile"),
      );
      const manifests = yield* declaredWorkspaceManifests();

      for (const stage of [
        "agentos-runtime-dependencies",
        "agentos-package-build",
      ]) {
        const start = dockerfile.indexOf(` AS ${stage}\n`);
        assert.isAtLeast(start, 0, `Dockerfile stage ${stage} must exist`);
        const nextStage = dockerfile.indexOf("\nFROM ", start + 1);
        const contents = dockerfile.slice(
          start,
          nextStage === -1 ? undefined : nextStage,
        );
        const missing = manifests.filter(
          (manifest) => !contents.includes(`COPY ${manifest} ${manifest}`),
        );
        assert.deepStrictEqual(
          missing,
          [],
          `${stage} is missing workspace manifests`,
        );
      }
    }).pipe(Effect.provide(platform)));

  it.effect("can prepare a persistent Mate home from production dependencies", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const systemPath = yield* Config.string("PATH");
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-production-runtime-",
      });
      const installation = paths.join(sandbox, "installation");
      const imageRoot = paths.join(sandbox, "image", "opt", "agentos");
      const home = paths.join(sandbox, "home");
      const fakeBin = paths.join(sandbox, "bin");
      yield* Effect.all([
        fileSystem.makeDirectory(installation, { recursive: true }),
        fileSystem.makeDirectory(
          paths.join(imageRoot, "packages", "agentos"),
          { recursive: true },
        ),
        fileSystem.makeDirectory(
          paths.join(imageRoot, "services", "egress-authz"),
          { recursive: true },
        ),
        fileSystem.makeDirectory(fakeBin, { recursive: true }),
      ], { concurrency: "unbounded" });
      yield* copyProductionInstallInputs(installation);

      const install = yield* run("bun", [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-progress",
        "--production",
        "--filter",
        "@agentos/root",
        "--filter",
        "@akua-dev/agentos",
        "--filter",
        "@agentos/github-app-token",
        "--filter",
        "@agentos/pg-listen",
        "--filter",
        "@agentos/a2a",
        "--filter",
        "@agentos/ai-gateway",
        "--filter",
        "@agentos/egress-authz",
        "--filter",
        "@agentos/github-broker",
        "--filter",
        "@agentos/openfga",
      ], { cwd: installation });
      assert.strictEqual(install.exitCode, 0, install.stderr);

      yield* Effect.all([
        fileSystem.rename(
          paths.join(installation, "node_modules"),
          paths.join(imageRoot, "node_modules"),
        ),
        fileSystem.rename(
          paths.join(installation, "packages", "agentos", "node_modules"),
          paths.join(imageRoot, "packages", "agentos", "node_modules"),
        ),
        fileSystem.rename(
          paths.join(installation, "services", "egress-authz", "node_modules"),
          paths.join(imageRoot, "services", "egress-authz", "node_modules"),
        ),
        fileSystem.copyFile(
          paths.join(installation, "packages", "agentos", "package.json"),
          paths.join(imageRoot, "packages", "agentos", "package.json"),
        ),
        fileSystem.copy(
          paths.join(repository, "packages", "agentos", "dist"),
          paths.join(imageRoot, "packages", "agentos", "dist"),
        ),
        fileSystem.copy(
          paths.join(repository, "packages", "agentos", "runtime"),
          paths.join(imageRoot, "packages", "agentos", "runtime"),
        ),
      ], { concurrency: "unbounded" });
      yield* Effect.forEach(["mise", "herdr"], (command) => {
        const executable = paths.join(fakeBin, command);
        return fileSystem.writeFileString(
          executable,
          "#!/usr/bin/env bun\n",
        ).pipe(Effect.andThen(fileSystem.chmod(executable, 0o755)));
      });

      const checkout = paths.join(home, "projects", "agentos");
      const distributionRoot = paths.join(checkout, "packages", "agentos");
      const roleDirectory = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      const environment = {
        AGENTOS_AGENT_CWD: roleDirectory,
        AGENTOS_AGENT_ROLE: "first_mate",
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        AGENTOS_RELEASE_ROOT: repository,
        HOME: home,
        MISE_SYSTEM_CONFIG_FILE: paths.join(repository, "mise.toml"),
        PATH: `${fakeBin}:${systemPath}`,
      };

      const prepared = yield* run("bun", [
        paths.join(
          imageRoot,
          "packages",
          "agentos",
          "runtime",
          "prepare-home.ts",
        ),
      ], { cwd: imageRoot, env: environment });
      assert.deepStrictEqual(
        prepared,
        { exitCode: 0, stderr: "", stdout: "" },
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(
          paths.join(home, "memory", "MEMORY.md"),
        ),
        "# Memory index\n",
      );

      const extension = yield* run("bun", [
        "-e",
        `import(${JSON.stringify(pathToFileURL(
          paths.join(distributionRoot, "extensions", "agentos.ts"),
        ).href)})`,
      ], { cwd: roleDirectory, env: environment });
      assert.strictEqual(extension.exitCode, 0, extension.stderr);

      const checkoutStatus = yield* run("git", [
        "-C",
        checkout,
        "status",
        "--porcelain",
      ], { cwd: checkout, env: environment });
      assert.deepStrictEqual(
        checkoutStatus,
        { exitCode: 0, stderr: "", stdout: "" },
      );
    })).pipe(Effect.provide(platform)), 30_000);
});
