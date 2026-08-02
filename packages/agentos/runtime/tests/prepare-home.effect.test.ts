import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
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
import { parse as parseTomlSource } from "toml";

const repositoryUrl = new URL("../../../..", import.meta.url);
const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const Trust = Schema.Record(Schema.String, Schema.Boolean);
const PiSettings = Schema.Struct({
  defaultModel: Schema.String,
  defaultProvider: Schema.String,
  defaultThinkingLevel: Schema.String,
  theme: Schema.String,
});
const PiModels = Schema.Struct({
  providers: Schema.Record(Schema.String, Schema.Struct({
    apiKey: Schema.String,
    baseUrl: Schema.String,
  })),
});
const ProviderMarker = Schema.Struct({
  _tag: Schema.String,
  version: Schema.Number,
});
const ProviderReadiness = Schema.Struct({
  files: Schema.Struct({
    markerSha256: Schema.NullOr(Schema.String),
    modelsSha256: Schema.NullOr(Schema.String),
    settingsSha256: Schema.NullOr(Schema.String),
  }),
  mode: Schema.Literals(["ai_gateway", "direct"]),
  selectedModel: Schema.NullOr(Schema.String),
  selectedThinking: Schema.NullOr(Schema.String),
  version: Schema.Literal(1),
});
const CodexConfig = Schema.Struct({
  model_provider: Schema.String,
  model_providers: Schema.Record(Schema.String, Schema.Struct({
    base_url: Schema.String,
    wire_api: Schema.String,
    auth: Schema.Struct({ refresh_interval_ms: Schema.Number }),
  })),
  otel: Schema.Struct({
    log_user_prompt: Schema.Boolean,
    environment: Schema.String,
    trace_exporter: Schema.Struct({
      "otlp-http": Schema.Struct({
        endpoint: Schema.String,
        protocol: Schema.String,
      }),
    }),
  }),
});
const HerdrConfig = Schema.Struct({
  onboarding: Schema.Boolean,
  version_check: Schema.Boolean,
  manifest_check: Schema.Boolean,
  session: Schema.Struct({ resume_agents_on_restore: Schema.Boolean }),
  experimental: Schema.Struct({ pane_history: Schema.Boolean }),
});

class PrepareHomeTestError extends Schema.TaggedErrorClass<PrepareHomeTestError>()(
  "PrepareHomeTestError",
  { operation: Schema.String },
) {}

function testError(operation: string) {
  return PrepareHomeTestError.make({ operation });
}

const makeExecutable = Effect.fn("test.prepareHome.makeExecutable")(function*(
  path: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(path, contents);
  yield* fileSystem.chmod(path, 0o755);
});

const run = Effect.fn("test.prepareHome.run")(function*(
  script: string,
  env: Readonly<Record<string, string>>,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("bun", [script], {
      env,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(Effect.mapError(() => testError("spawn")));
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

const commandText = Effect.fn("test.prepareHome.commandText")(function*(
  executable: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(args), {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(Effect.mapError(() => testError("command")));
  if (result.exitCode !== 0) return yield* testError("command");
  return result.stdout.trim();
});

function withoutEnvironment(
  environment: Readonly<Record<string, string>>,
  names: ReadonlyArray<string>,
) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.includes(name)),
  );
}

function readJson<S extends Schema.ConstraintDecoder<unknown>>(
  fileSystem: FileSystem.FileSystem,
  path: string,
  schema: S,
) {
  return fileSystem.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
  );
}

function encodeJson<S extends Schema.Constraint>(schema: S, value: S["Type"]) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value);
}

function parseToml<S extends Schema.ConstraintDecoder<unknown>>(
  source: string,
  schema: S,
) {
  return Effect.try({
    try: () => parseTomlSource(source),
    catch: () => testError("toml"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
}

layer(platform)("Mate home preparation", (it) => {
  it.effect(
    "reconciles Codex native OTEL config for a Crewmate from standard workload variables",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const repository = paths.resolve(yield* paths.fromFileUrl(repositoryUrl));
      const prepareHome = paths.join(
        repository,
        "packages",
        "agentos",
        "runtime",
        "prepare-home.ts",
      );
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-crewmate-home-",
      });
      const home = paths.join(sandbox, "home");
      const fakeBin = paths.join(sandbox, "bin");
      yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
      yield* makeExecutable(paths.join(fakeBin, "mise"), "#!/bin/sh\nexit 0\n");

      const result = yield* run(prepareHome, {
        AGENTOS_ASSIGNMENT_ID: "20000000-0000-4000-8000-000000000001",
        AGENTOS_AGENT_ROLE: "crewmate",
        AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
        AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
        AGENTOS_RELEASE_ROOT: repository,
        AI_GATEWAY_URL:
          "http://agentgateway-openai.agentos.svc.cluster.local:8788",
        HOME: home,
        MISE_SYSTEM_CONFIG_FILE: paths.join(repository, "mise.toml"),
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://agentos-otel-collector:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment.name=test,service.namespace=agentos",
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_EXPORTER: "otlp",
        PATH: `${fakeBin}:${executablePath}`,
      });

      assert.deepStrictEqual(result, { exitCode: 0, stderr: "", stdout: "" });
      const configPath = paths.join(home, ".codex", "config.toml");
      const config = yield* fileSystem.readFileString(configPath).pipe(
        Effect.flatMap((source) => parseToml(source, CodexConfig)),
      );
      assert.strictEqual(config.model_provider, "agentos-gateway");
      assert.deepInclude(config.model_providers["agentos-gateway"], {
        base_url: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
        wire_api: "responses",
        auth: { refresh_interval_ms: 60_000 },
      });
      assert.isFalse(config.otel.log_user_prompt);
      assert.strictEqual(config.otel.environment, "test");
      assert.deepStrictEqual(config.otel.trace_exporter, {
        "otlp-http": {
          endpoint: "http://agentos-otel-collector:4318/v1/traces",
          protocol: "binary",
        },
      });
      assert.strictEqual(Number((yield* fileSystem.stat(configPath)).mode) & 0o777, 0o600);
    })),
    120_000,
  );

  it.effect(
    "seeds a checkout and selected Pi defaults while preserving the agent-owned home",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const repository = paths.resolve(yield* paths.fromFileUrl(repositoryUrl));
      const prepareHome = paths.join(repository, "packages", "agentos", "runtime", "prepare-home.ts");
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-firstmate-home-",
      });
      const home = paths.join(sandbox, "home");
      const fakeBin = paths.join(sandbox, "bin");
      const logDirectory = paths.join(sandbox, "logs");
      const customFragment = paths.join(home, ".config", "mise", "conf.d", "custom.toml");
      const customTool = paths.join(home, ".local", "share", "mise", "installs", "custom", "marker");
      const herdrConfig = paths.join(home, ".config", "herdr", "config.toml");
      const piSettings = paths.join(home, ".pi", "agent", "settings.json");
      const pgpassSource = paths.join(sandbox, "secrets", "pgpass");
      yield* Effect.forEach([
        fakeBin,
        logDirectory,
        paths.dirname(customFragment),
        paths.dirname(customTool),
        paths.join(home, ".pi", "agent"),
        paths.dirname(pgpassSource),
      ], (directory) => fileSystem.makeDirectory(directory, { recursive: true }), {
        concurrency: "unbounded",
      });
      const initialSettings = yield* encodeJson(PiSettings, {
        defaultModel: "gpt-5.4",
        defaultProvider: "openai-codex",
        defaultThinkingLevel: "low",
        theme: "agent-owned",
      });
      const initialTrust = yield* encodeJson(Trust, { "/workspace": false });
      yield* Effect.all([
        fileSystem.writeFileString(customFragment, '[tools]\npython = "3.13"\n'),
        fileSystem.writeFileString(customTool, "agent-owned\n"),
        fileSystem.writeFileString(piSettings, `${initialSettings}\n`),
        fileSystem.writeFileString(paths.join(home, ".pi", "agent", "trust.json"), `${initialTrust}\n`),
        fileSystem.writeFileString(
          pgpassSource,
          "postgres.example.internal:5432:agentos:runtime_second:secret\n",
        ),
        makeExecutable(
          paths.join(fakeBin, "mise"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIRECTORY/mise.log"
`,
        ),
        makeExecutable(
          paths.join(fakeBin, "herdr"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIRECTORY/herdr.log"
if [ "$*" = "integration install pi" ]; then
  extensions="$HOME/.pi/agent/extensions"
  test -e "$extensions" || exit 1
  printf 'installed\\n' > "$extensions/herdr-agent-state.ts"
fi
`,
        ),
      ], { concurrency: "unbounded" });

      const checkout = paths.join(home, "projects", "agentos");
      const distributionRoot = paths.join(checkout, "packages", "agentos");
      const roleDirectory = paths.join(distributionRoot, "resources", "roles", "firstmate");
      const environment = {
        AGENTOS_RELEASE_ROOT: repository,
        AGENTOS_AGENT_CWD: roleDirectory,
        AGENTOS_AGENT_ROLE: "first_mate",
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
        AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
        AGENTOS_THINKING: "xhigh",
        AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788/",
        FAKE_LOG_DIRECTORY: logDirectory,
        HERDR_CONFIG_PATH: herdrConfig,
        HOME: home,
        AGENTOS_PGPASS_SOURCE: pgpassSource,
        MISE_SYSTEM_CONFIG_FILE: paths.join(repository, "mise.toml"),
        PATH: `${fakeBin}:${executablePath}`,
      };

      assert.deepStrictEqual(yield* run(prepareHome, environment), {
        exitCode: 0,
        stderr: "",
        stdout: "",
      });
      assert.isFalse(yield* fileSystem.exists(paths.join(home, ".config", "mise", "config.toml")));
      assert.isFalse(yield* fileSystem.exists(paths.join(home, ".agents", "skills", "agentos-delegation")));
      assert.strictEqual(
        yield* commandText("git", ["-C", checkout, "rev-parse", "HEAD"]),
        yield* commandText("git", ["-C", repository, "rev-parse", "HEAD"]),
      );
      assert.strictEqual(
        yield* commandText("git", ["-C", checkout, "remote", "get-url", "origin"]),
        yield* commandText("git", ["-C", repository, "remote", "get-url", "origin"]),
      );
      assert.strictEqual(yield* fileSystem.readFileString(customFragment), '[tools]\npython = "3.13"\n');
      assert.strictEqual(yield* fileSystem.readFileString(customTool), "agent-owned\n");
      assert.deepStrictEqual(
        yield* readJson(fileSystem, paths.join(home, ".pi", "agent", "trust.json"), Trust),
        { "/workspace": false, [repository]: true, [checkout]: true, [distributionRoot]: true },
      );
      assert.deepStrictEqual(yield* readJson(fileSystem, piSettings, PiSettings), {
        defaultModel: "gpt-5.6-sol",
        defaultProvider: "openai-codex",
        defaultThinkingLevel: "xhigh",
        theme: "agent-owned",
      });
      const piModels = paths.join(home, ".pi", "agent", "models.json");
      const providerMarker = paths.join(home, ".local", "state", "agentos", "pi-provider.json");
      const providerReadiness = paths.join(home, ".local", "state", "agentos", "pi-provider-readiness.json");
      const models = yield* readJson(fileSystem, piModels, PiModels);
      assert.deepStrictEqual(models.providers["openai-codex"], {
        apiKey: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder",
        baseUrl: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      });
      assert.deepInclude(yield* readJson(fileSystem, providerMarker, ProviderMarker), {
        _tag: "Active",
        version: 1,
      });
      assert.notInclude(yield* fileSystem.readFileString(piModels), "AI_GATEWAY_TOKEN");
      const gatewayReadiness = yield* readJson(fileSystem, providerReadiness, ProviderReadiness);
      assert.strictEqual(gatewayReadiness.mode, "ai_gateway");
      assert.strictEqual(gatewayReadiness.selectedModel, "openai-codex/gpt-5.6-sol");
      assert.strictEqual(gatewayReadiness.selectedThinking, "xhigh");
      for (const digest of [
        gatewayReadiness.files.markerSha256,
        gatewayReadiness.files.modelsSha256,
        gatewayReadiness.files.settingsSha256,
      ]) assert.match(digest ?? "", /^[0-9a-f]{64}$/);
      assert.strictEqual(Number((yield* fileSystem.stat(providerReadiness)).mode) & 0o777, 0o600);
      assert.strictEqual(
        yield* fileSystem.readFileString(paths.join(home, ".pgpass")),
        "postgres.example.internal:5432:agentos:runtime_second:secret\n",
      );
      assert.strictEqual(Number((yield* fileSystem.stat(paths.join(home, ".pgpass"))).mode) & 0o777, 0o600);
      const herdr = yield* fileSystem.readFileString(herdrConfig).pipe(
        Effect.flatMap((source) => parseToml(source, HerdrConfig)),
      );
      assert.deepStrictEqual(herdr, {
        onboarding: false,
        version_check: false,
        manifest_check: false,
        session: { resume_agents_on_restore: true },
        experimental: { pane_history: false },
      });
      assert.strictEqual(
        yield* fileSystem.readFileString(paths.join(home, ".pi", "agent", "extensions", "herdr-agent-state.ts")),
        "installed\n",
      );
      assert.strictEqual(yield* fileSystem.readFileString(paths.join(home, "memory", "MEMORY.md")), "# Memory index\n");
      assert.isFalse(yield* fileSystem.exists(paths.join(home, ".pi", "agent", "extensions", "agentos-pi-defaults.ts")));
      assert.deepStrictEqual(
        (yield* fileSystem.readFileString(paths.join(logDirectory, "mise.log"))).trim().split("\n"),
        [
          `trust ${paths.join(repository, "mise.toml")}`,
          `trust ${paths.join(checkout, "mise.toml")}`,
          `trust ${paths.join(roleDirectory, "mise.toml")}`,
        ],
      );
      assert.deepStrictEqual(
        (yield* fileSystem.readFileString(paths.join(logDirectory, "herdr.log"))).trim().split("\n"),
        ["integration install pi"],
      );

      const customHerdrConfig = '[theme]\nname = "agent-owned"\n';
      yield* fileSystem.writeFileString(paths.join(home, "memory", "MEMORY.md"), "# Memory index\n- Preserve this\n");
      yield* fileSystem.writeFileString(herdrConfig, customHerdrConfig);
      yield* fileSystem.writeFileString(piSettings, `${initialSettings}\n`);
      assert.deepStrictEqual(yield* run(prepareHome, environment), { exitCode: 0, stderr: "", stdout: "" });
      assert.strictEqual(yield* fileSystem.readFileString(herdrConfig), customHerdrConfig);
      assert.strictEqual(yield* fileSystem.readFileString(paths.join(home, "memory", "MEMORY.md")), "# Memory index\n- Preserve this\n");
      assert.deepStrictEqual(yield* readJson(fileSystem, piSettings, PiSettings), {
        defaultModel: "gpt-5.6-sol",
        defaultProvider: "openai-codex",
        defaultThinkingLevel: "xhigh",
        theme: "agent-owned",
      });
      const persistentMarker = paths.join(checkout, ".fleet-marker");
      yield* fileSystem.writeFileString(persistentMarker, "unfinished work\n");
      assert.deepStrictEqual(yield* run(prepareHome, environment), { exitCode: 0, stderr: "", stdout: "" });
      assert.strictEqual(yield* fileSystem.readFileString(persistentMarker), "unfinished work\n");

      const directEnvironment = {
        ...withoutEnvironment(environment, ["AI_GATEWAY_URL"]),
        AGENTOS_PI_PROVIDER_MODE: "direct",
      };
      assert.deepStrictEqual(yield* run(prepareHome, directEnvironment), { exitCode: 0, stderr: "", stdout: "" });
      assert.isUndefined((yield* readJson(fileSystem, piModels, PiModels)).providers["openai-codex"]);
      assert.isFalse(yield* fileSystem.exists(providerMarker));
      const directReadiness = yield* readJson(fileSystem, providerReadiness, ProviderReadiness);
      assert.strictEqual(directReadiness.mode, "direct");
      assert.isNull(directReadiness.files.markerSha256);
      assert.deepStrictEqual(
        yield* run(prepareHome, withoutEnvironment(environment, ["AGENTOS_PI_PROVIDER_MODE", "AI_GATEWAY_URL"])),
        { exitCode: 0, stderr: "", stdout: "" },
      );
    })),
    120_000,
  );

  it.effect(
    "materializes a selected distribution into an existing retained checkout",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const repository = paths.resolve(yield* paths.fromFileUrl(repositoryUrl));
      const prepareHome = paths.join(repository, "packages", "agentos", "runtime", "prepare-home.ts");
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-retained-distribution-" });
      const home = paths.join(sandbox, "home");
      const fakeBin = paths.join(sandbox, "bin");
      const logDirectory = paths.join(sandbox, "logs");
      const checkout = paths.join(home, "projects", "agentos");
      const oldRole = paths.join(checkout, "agents", "firstmate");
      const distributionRoot = paths.join(checkout, "packages", "agentos");
      const roleDirectory = paths.join(distributionRoot, "resources", "roles", "firstmate");
      yield* Effect.forEach([fakeBin, logDirectory, paths.join(checkout, ".git"), oldRole],
        (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
        { concurrency: "unbounded" });
      yield* Effect.all([
        fileSystem.writeFileString(paths.join(checkout, "mise.toml"), "[tools]\n"),
        fileSystem.writeFileString(paths.join(oldRole, "unfinished.md"), "keep me\n"),
        makeExecutable(paths.join(fakeBin, "mise"), `#!/bin/sh
if [ "$1" = "trust" ] && [ ! -e "$2" ]; then exit 1; fi
printf '%s\\n' "$*" >> "$FAKE_LOG_DIRECTORY/mise.log"
`),
        makeExecutable(paths.join(fakeBin, "herdr"), `#!/bin/sh
if [ "$*" != "integration install pi" ]; then exit 1; fi
`),
      ], { concurrency: "unbounded" });
      const result = yield* run(prepareHome, {
        AGENTOS_AGENT_CWD: roleDirectory,
        AGENTOS_AGENT_ROLE: "first_mate",
        AGENTOS_CHECKOUT: checkout,
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        AGENTOS_RELEASE_ROOT: repository,
        FAKE_LOG_DIRECTORY: logDirectory,
        HOME: home,
        HERDR_CONFIG_PATH: paths.join(home, ".config", "herdr", "config.toml"),
        MISE_SYSTEM_CONFIG_FILE: paths.join(repository, "mise.toml"),
        PATH: `${fakeBin}:${executablePath}`,
      });
      assert.deepStrictEqual(result, { exitCode: 0, stderr: "", stdout: "" });
      assert.isTrue(yield* fileSystem.exists(roleDirectory));
      assert.strictEqual(yield* fileSystem.readFileString(paths.join(oldRole, "unfinished.md")), "keep me\n");
    })),
    120_000,
  );

  it.effect(
    "does not infer a Mate distribution from the checkout or current directory",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const repository = paths.resolve(yield* paths.fromFileUrl(repositoryUrl));
      const prepareHome = paths.join(repository, "packages", "agentos", "runtime", "prepare-home.ts");
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-missing-distribution-" });
      const result = yield* run(prepareHome, {
        AGENTOS_AGENT_CWD: paths.join(sandbox, "home", "projects", "agentos", "packages", "default", "resources", "roles", "firstmate"),
        AGENTOS_AGENT_ROLE: "first_mate",
        AGENTOS_RELEASE_ROOT: repository,
        HOME: paths.join(sandbox, "home"),
        PATH: executablePath,
      });
      assert.strictEqual(result.exitCode, 1);
      assert.include(result.stderr, "AGENTOS_DISTRIBUTION_ROOT");
    })),
    120_000,
  );
});
