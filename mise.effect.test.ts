import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const RequestedTools = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Struct({ requested_version: Schema.String })),
);
const MiseConfig = Schema.Struct({
  tools: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Struct({
        format: Schema.optional(Schema.String),
        version: Schema.optional(Schema.String),
      }),
    ]),
  ),
});
const MiseLock = Schema.Struct({
  tools: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  ),
});
const LockedTool = Schema.Struct({ backend: Schema.String, version: Schema.String });
const LockedPlatform = Schema.Struct({
  checksum: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  url_api: Schema.optional(Schema.String),
});

class MiseTestError extends Schema.TaggedErrorClass<MiseTestError>()(
  "MiseTestError",
  {
    operation: Schema.Literals(["fixture", "process", "toml"]),
    detail: Schema.String,
  },
) {}

function testError(
  operation: typeof MiseTestError.fields.operation.Type,
  detail: string,
) {
  return MiseTestError.make({ operation, detail });
}

const root = fileURLToPath(new URL(".", import.meta.url));
const bunRevision = "1.4.0-canary.1+3979cbe80";
const bunToolchainTag = "bun-toolchain-1.4.0-canary.1-3979cbe80-r2";

const runMise = Effect.fn("test.mise.run")(function*(
  cwd: string,
  systemConfigDirectory: string,
  contaminatedEnvironment: Readonly<Record<string, string>> = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const executablePath = yield* Config.string("PATH");
  const home = paths.join(systemConfigDirectory, "home");
  yield* fileSystem.makeDirectory(home, { recursive: true });
  const environment = Object.fromEntries(
    Object.entries({ PATH: executablePath, ...contaminatedEnvironment }).filter(
      ([name]) => !name.startsWith("MISE_") && !name.startsWith("__MISE_"),
    ),
  );
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(
      "mise",
      ["ls", "--current", "--json"],
      {
        cwd,
        env: {
          ...environment,
          HOME: home,
          MISE_CACHE_DIR: paths.join(systemConfigDirectory, "cache"),
          MISE_CEILING_PATHS: paths.dirname(cwd),
          MISE_CONFIG_DIR: paths.join(home, ".config", "mise"),
          MISE_DATA_DIR: paths.join(systemConfigDirectory, "data"),
          MISE_SYSTEM_CONFIG_DIR: systemConfigDirectory,
          MISE_TRUSTED_CONFIG_PATHS: cwd,
        },
        extendEnv: false,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(
    Effect.mapError(() => testError("process", "mise process failed")),
  );
});

const requestedTools = Effect.fn("test.mise.requestedTools")(function*(
  stdout: string,
) {
  const tools = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(RequestedTools),
  )(stdout);
  return Object.fromEntries(
    Object.entries(tools).map(([tool, versions]) => [
      tool,
      versions[0]?.requested_version,
    ]),
  );
});

const installFleetBaseline = Effect.fn("test.mise.installFleetBaseline")(
  function*(systemConfigDirectory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const agentConfigDirectory = paths.join(
      systemConfigDirectory,
      "home",
      ".config",
      "mise",
    );
    yield* Effect.all([
      fileSystem.makeDirectory(systemConfigDirectory, { recursive: true }),
      fileSystem.makeDirectory(agentConfigDirectory, { recursive: true }),
    ], { concurrency: "unbounded" });
    yield* Effect.all([
      fileSystem.copyFile(
        paths.join(root, "mise.toml"),
        paths.join(systemConfigDirectory, "config.toml"),
      ),
      fileSystem.copyFile(
        paths.join(root, "mise.lock"),
        paths.join(systemConfigDirectory, "mise.lock"),
      ),
      fileSystem.copyFile(
        paths.join(root, "mise.toml"),
        paths.join(agentConfigDirectory, "config.toml"),
      ),
      fileSystem.copyFile(
        paths.join(root, "mise.lock"),
        paths.join(agentConfigDirectory, "mise.lock"),
      ),
    ], { concurrency: "unbounded" });
  },
);

const parseToml = Effect.fn("test.mise.parseToml")((source: string) =>
  Effect.try({
    try: () => Bun.TOML.parse(source),
    catch: () => testError("toml", "invalid TOML fixture"),
  }));

const fleetTools = {
  fd: "10.4.2",
  gh: "2.96.0",
  "github:derailed/k9s": "0.51.0",
  "github:akua-dev/cli": "v0.9.0",
  "github:kunchenguid/no-mistakes": "1.40.3",
  "github:kunchenguid/treehouse": "2.0.0",
  "github:ogulcancelik/herdr": "0.7.3",
  "http:bun": bunRevision,
  jq: "1.8.2",
  kubectl: "1.35.6",
  node: "24",
  "npm:@earendil-works/pi-coding-agent": "0.81.1",
  "npm:@openai/codex": "0.144.5",
  "npm:chrome-devtools-axi": "0.1.26",
  "npm:gh-axi": "0.1.27",
  "npm:lavish-axi": "0.1.42",
  "npm:quota-axi": "0.1.5",
  ripgrep: "15.1.0",
  vcluster: "0.35.2",
};

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

describe("AgentOS mise baseline", () => {
  it.effect("installs the exact Bun revision from durable locked release assets", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const config = yield* fileSystem.readFileString(
        paths.join(root, "mise.toml"),
      ).pipe(
        Effect.flatMap(parseToml),
        Effect.flatMap(Schema.decodeUnknownEffect(MiseConfig)),
      );
      const lock = yield* fileSystem.readFileString(
        paths.join(root, "mise.lock"),
      ).pipe(
        Effect.flatMap(parseToml),
        Effect.flatMap(Schema.decodeUnknownEffect(MiseLock)),
      );
      const rawBun = lock.tools["http:bun"]?.[0];
      if (rawBun === undefined) {
        return yield* testError("fixture", "Bun lock entry is missing");
      }
      const bun = yield* Schema.decodeUnknownEffect(LockedTool)(rawBun);
      assert.deepInclude(config.tools["http:bun"], { version: bunRevision });
      assert.strictEqual(bun.version, bunRevision);
      const platforms = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Tuple([Schema.String, LockedPlatform])),
      )(
        Object.entries(rawBun).filter(([key]) => key.startsWith("platforms.")),
      );
      assert.lengthOf(platforms, 7);
      for (const [, lockedPlatform] of platforms) {
        assert.match(lockedPlatform.checksum ?? "", /^sha256:[a-f0-9]{64}$/);
        assert.match(
          lockedPlatform.url ?? "",
          new RegExp(
            `^https://github\\.com/akua-dev/agentos/releases/download/${bunToolchainTag}/bun-`,
          ),
        );
        assert.isUndefined(lockedPlatform.url_api);
      }
    }).pipe(Effect.provide(platform)));

  it.effect("provides baseline tools outside the AgentOS repository", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-mise-baseline-",
      });
      const systemConfigDirectory = paths.join(temporaryDirectory, "etc-mise");
      const foreignWorktree = paths.join(temporaryDirectory, "foreign-worktree");
      yield* fileSystem.makeDirectory(foreignWorktree, { recursive: true });
      yield* installFleetBaseline(systemConfigDirectory);
      const result = yield* runMise(foreignWorktree, systemConfigDirectory);
      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.deepStrictEqual(yield* requestedTools(result.stdout), fleetTools);
    }).pipe(Effect.provide(platform)));

  it.effect("lets a foreign worktree override one tool and retain the baseline", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-mise-override-",
      });
      const systemConfigDirectory = paths.join(temporaryDirectory, "etc-mise");
      const foreignWorktree = paths.join(temporaryDirectory, "foreign-worktree");
      yield* fileSystem.makeDirectory(foreignWorktree, { recursive: true });
      yield* installFleetBaseline(systemConfigDirectory);
      yield* fileSystem.writeFileString(
        paths.join(foreignWorktree, "mise.toml"),
        '[tools]\nnode = "22"\n',
      );
      const result = yield* runMise(foreignWorktree, systemConfigDirectory, {
        MISE_NODE_VERSION: "24",
      });
      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.deepStrictEqual(yield* requestedTools(result.stdout), {
        ...fleetTools,
        node: "22",
      });
      assert.strictEqual(result.stderr, "");
    }).pipe(Effect.provide(platform)));
});
