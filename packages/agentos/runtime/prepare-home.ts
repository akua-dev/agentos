#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  AgentOSIdentifier,
  attestPiProviderReadinessEffect,
  createMateMemoryStoreEffect,
} from "@akua-dev/agentos";
import {
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  isPersistentMateRole,
  resolvePersistentMateDistribution,
  type DistributionEnvironment,
  type PersistentMateDistribution,
} from "./distribution.ts";
import { reconcileCodexOtelConfig } from "./codex-otel.ts";
import { reconcileCodexProviderConfigurationEffect } from "./codex-provider.ts";
import { reconcilePiConfigurationEffect } from "./pi-provider.ts";

export class PrepareHomeError extends Schema.TaggedErrorClass<PrepareHomeError>()(
  "PrepareHomeError",
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const prepareError = (message: string, cause?: unknown) =>
  PrepareHomeError.make({ cause, message });

const environmentKeys = [
  "AGENTOS_AGENT_CWD",
  "AGENTOS_AGENT_ROLE",
  "AGENTOS_ASSIGNMENT_ID",
  "AGENTOS_CHECKOUT",
  "AGENTOS_CODEX_PROVIDER_MODE",
  "AGENTOS_DISTRIBUTION_ROOT",
  "AGENTOS_EGRESS_TOKEN_FILE",
  "AGENTOS_MODEL",
  "AGENTOS_PGPASS_SOURCE",
  "AGENTOS_PI_PROVIDER_MODE",
  "AGENTOS_RELEASE_ROOT",
  "AGENTOS_THINKING",
  "AI_GATEWAY_URL",
  "CODEX_HOME",
  "FAKE_LOG_DIRECTORY",
  "HERDR_CONFIG_PATH",
  "HOME",
  "MISE_CONFIG_DIR",
  "MISE_SYSTEM_CONFIG_FILE",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "PATH",
  "PI_CODING_AGENT_DIR",
] satisfies ReadonlyArray<string>;

const readEnvironment = Effect.forEach(environmentKeys, (key) =>
  Config.option(Config.string(key)).pipe(
    Effect.map((value) => ({ key, value: Option.getOrUndefined(value) })),
  )).pipe(
    Effect.map((entries) =>
      Object.fromEntries(entries.map(({ key, value }) => [key, value]))
    ),
  );

export const prepareHome = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const environment = yield* readEnvironment;
  const home = yield* requiredEnvironment(environment, "HOME", "must point at the mounted Mate home");
  const releaseRoot = withoutTrailingSlash(environment.AGENTOS_RELEASE_ROOT ?? "/opt/agentos");
  const systemConfig = environment.MISE_SYSTEM_CONFIG_FILE ?? "/etc/mise/config.toml";
  const agentConfigDirectory = environment.MISE_CONFIG_DIR ?? paths.join(home, ".config", "mise");
  const herdrConfig = environment.HERDR_CONFIG_PATH ?? paths.join(home, ".config", "herdr", "config.toml");
  const agentRole = yield* requiredEnvironment(environment, "AGENTOS_AGENT_ROLE", "must be configured");
  const usesPi = isPersistentMateRole(agentRole);
  const usesCodex = agentRole === "crewmate";
  const codexHome = environment.CODEX_HOME ?? paths.join(home, ".codex");
  const mateDistribution = usesPi
    ? yield* resolvePersistentMateDistribution(environment)
    : undefined;
  const agentCheckout = environment.AGENTOS_CHECKOUT ?? paths.join(home, "projects", "agentos");
  const piAgentDirectory = environment.PI_CODING_AGENT_DIR ?? paths.join(home, ".pi", "agent");
  const piExtensionDirectory = paths.join(piAgentDirectory, "extensions");

  yield* Effect.forEach([
    paths.join(agentConfigDirectory, "conf.d"),
    paths.join(home, ".local", "bin"),
    paths.join(home, ".local", "share", "mise"),
    paths.join(home, ".local", "state", "agentos"),
    paths.join(home, ".agents", "skills"),
    paths.join(home, "projects"),
    paths.dirname(herdrConfig),
    ...(usesPi ? [piExtensionDirectory] : []),
    ...(usesCodex ? [codexHome] : []),
  ], (directory) => fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }), {
    concurrency: "unbounded",
    discard: true,
  });

  if (mateDistribution !== undefined) {
    yield* ensureAgentosCheckout(releaseRoot, agentCheckout, environment);
    yield* ensureSelectedDistribution(releaseRoot, agentCheckout, mateDistribution);
    yield* reconcileDefaultDistributionRuntime(releaseRoot, agentCheckout, mateDistribution);
    const memoryStore = yield* createMateMemoryStoreEffect(home);
    yield* memoryStore.ensureLayout();
  }

  if (environment.AGENTOS_PGPASS_SOURCE) {
    yield* copyPrivateFileAtomic(environment.AGENTOS_PGPASS_SOURCE, paths.join(home, ".pgpass"));
  }

  if (!(yield* fileSystem.exists(herdrConfig))) {
    yield* fileSystem.writeFileString(herdrConfig, [
      "onboarding = false",
      "version_check = false",
      "manifest_check = false",
      "",
      "[session]",
      "resume_agents_on_restore = true",
      "",
      "[experimental]",
      "pane_history = false",
      "",
    ].join("\n"), { mode: 0o600 });
  }

  const stateDirectory = paths.join(home, ".local", "state", "agentos");
  if (usesPi) {
    yield* reconcilePiConfigurationEffect({ environment, piAgentDirectory, stateDirectory });
    yield* attestPiProviderReadinessEffect({ environment, piAgentDirectory, stateDirectory });
  }
  if (usesCodex) {
    const configPath = paths.join(codexHome, "config.toml");
    yield* reconcileCodexProviderConfigurationEffect({ configPath, environment, stateDirectory });
    yield* reconcileCodexOtelConfig(configPath, environment);
  }

  yield* runCommand(["mise", "trust", systemConfig], environment);
  if (mateDistribution !== undefined) {
    yield* runCommand(["mise", "trust", paths.join(agentCheckout, "mise.toml")], environment);
    yield* runCommand(["mise", "trust", paths.join(mateDistribution.roleDirectory, "mise.toml")], environment);
    yield* reconcilePiTrust(
      paths.join(piAgentDirectory, "trust.json"),
      [releaseRoot, agentCheckout, mateDistribution.distributionRoot],
    );
    yield* runCommand(["herdr", "integration", "install", "pi"], environment);
  }
});

function requiredEnvironment(
  environment: DistributionEnvironment,
  name: string,
  requirement: string,
) {
  const value = environment[name]?.trim();
  return value
    ? Effect.succeed(value)
    : Effect.fail(prepareError(`${name} ${requirement}`));
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const copyPrivateFileAtomic = Effect.fn("agentos.prepareHome.copyPrivate")(
  function*(source: string, destination: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const next = `${destination}.agentos-next`;
    yield* Effect.gen(function*() {
      yield* fileSystem.copyFile(source, next);
      yield* fileSystem.chmod(next, 0o600);
      yield* fileSystem.rename(next, destination);
    }).pipe(Effect.ensuring(fileSystem.remove(next, { force: true }).pipe(Effect.ignore)));
  },
);

const ensureAgentosCheckout = Effect.fn("agentos.prepareHome.ensureCheckout")(
  function*(releaseRoot: string, agentCheckout: string, environment: DistributionEnvironment) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (yield* fileSystem.exists(paths.join(agentCheckout, ".git"))) return;
    if (yield* fileSystem.exists(agentCheckout)) {
      return yield* prepareError(`${agentCheckout} exists but is not an AgentOS Git checkout`);
    }
    if (!(yield* fileSystem.exists(paths.join(releaseRoot, ".git")))) {
      return yield* prepareError(`${releaseRoot} must contain the image's AgentOS Git seed`);
    }
    yield* runCommand([
      "git", "-c", `safe.directory=${releaseRoot}`, "clone", "--no-hardlinks", releaseRoot, agentCheckout,
    ], environment);
    yield* copyReleaseRemotes(releaseRoot, agentCheckout, environment);
  },
);

const ensureSelectedDistribution = Effect.fn(
  "agentos.prepareHome.ensureDistribution",
)(function*(
  releaseRoot: string,
  agentCheckout: string,
  distribution: PersistentMateDistribution,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  if (yield* fileSystem.exists(distribution.roleDirectory)) return;
  if (yield* fileSystem.exists(distribution.distributionRoot)) {
    return yield* prepareError(
      `${distribution.distributionRoot} exists but does not contain ${distribution.roleDirectory}`,
    );
  }
  const distributionPath = paths.relative(agentCheckout, distribution.distributionRoot);
  if (!distributionPath || paths.isAbsolute(distributionPath) || distributionPath === ".." || distributionPath.startsWith("../")) {
    return yield* prepareError(
      `${distribution.distributionRoot} is not a selected distribution in ${agentCheckout}`,
    );
  }
  const releaseDistribution = paths.join(releaseRoot, distributionPath);
  if (!(yield* fileSystem.exists(releaseDistribution))) {
    return yield* prepareError(
      `Selected distribution ${distribution.distributionRoot} is missing from ${releaseRoot}`,
    );
  }
  const parent = paths.dirname(distribution.distributionRoot);
  yield* fileSystem.makeDirectory(parent, { recursive: true, mode: 0o700 });
  const temporaryParent = yield* fileSystem.makeTempDirectory({ directory: parent, prefix: ".agentos-distribution-" });
  const temporaryDistribution = paths.join(temporaryParent, paths.basename(distribution.distributionRoot));
  yield* Effect.gen(function*() {
    yield* fileSystem.copy(releaseDistribution, temporaryDistribution);
    if (yield* fileSystem.exists(distribution.distributionRoot)) {
      return yield* prepareError(
        `${distribution.distributionRoot} appeared while preparing the selected distribution`,
      );
    }
    yield* fileSystem.rename(temporaryDistribution, distribution.distributionRoot);
  }).pipe(
    Effect.ensuring(fileSystem.remove(temporaryParent, { force: true, recursive: true }).pipe(Effect.ignore)),
  );
});

const reconcileDefaultDistributionRuntime = Effect.fn(
  "agentos.prepareHome.reconcileDefaultRuntime",
)(function*(
  releaseRoot: string,
  agentCheckout: string,
  distribution: PersistentMateDistribution,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const defaultDistribution = paths.join(agentCheckout, "packages", "agentos");
  if (distribution.distributionRoot !== defaultDistribution) return;
  const releaseDist = paths.join(releaseRoot, "packages", "agentos", "dist");
  if (!(yield* fileSystem.exists(releaseDist))) {
    return yield* prepareError(`The immutable AgentOS release is missing its compiled package at ${releaseDist}`);
  }
  const checkoutDist = paths.join(distribution.distributionRoot, "dist");
  const current = yield* fileSystem.stat(checkoutDist).pipe(Effect.result);
  if (Result.isSuccess(current)) {
    if (current.success.type !== "SymbolicLink") return;
    const target = yield* fileSystem.readLink(checkoutDist);
    if (target !== releaseDist) return;
  } else if (current.failure.reason._tag !== "NotFound") {
    return yield* current.failure;
  }

  const next = `${checkoutDist}.agentos-next`;
  yield* Effect.gen(function*() {
    yield* fileSystem.remove(next, { force: true, recursive: true });
    yield* fileSystem.makeDirectory(next, { mode: 0o700 });
    const entries = yield* fileSystem.readDirectory(releaseDist);
    yield* Effect.forEach(
      entries,
      (entry) =>
        fileSystem.symlink(
          paths.join(releaseDist, entry),
          paths.join(next, entry),
        ),
      { discard: true },
    );
    yield* fileSystem.remove(checkoutDist, { force: true, recursive: true });
    yield* fileSystem.rename(next, checkoutDist);
  }).pipe(Effect.ensuring(fileSystem.remove(next, { force: true, recursive: true }).pipe(Effect.ignore)));
});

const copyReleaseRemotes = Effect.fn("agentos.prepareHome.copyRemotes")(
  function*(releaseRoot: string, agentCheckout: string, environment: DistributionEnvironment) {
    const source = yield* runCommand([
      "git", "-c", `safe.directory=${releaseRoot}`, "-C", releaseRoot, "remote",
    ], environment);
    const remotes = nonemptyLines(source);
    const localOrigin = yield* runCommand(["git", "-C", agentCheckout, "remote"], environment);
    yield* Effect.forEach(
      nonemptyLines(localOrigin),
      (remote) =>
        runCommand(
          ["git", "-C", agentCheckout, "remote", "remove", remote],
          environment,
        ),
      { discard: true },
    );
    for (const remote of remotes) {
      const output = yield* runCommand([
        "git", "-c", `safe.directory=${releaseRoot}`, "-C", releaseRoot, "remote", "get-url", "--all", remote,
      ], environment);
      const urls = nonemptyLines(output);
      const first = urls[0];
      if (first === undefined) continue;
      yield* runCommand(["git", "-C", agentCheckout, "remote", "add", remote, first], environment);
      yield* Effect.forEach(
        urls.slice(1),
        (url) =>
          runCommand(
            ["git", "-C", agentCheckout, "remote", "set-url", "--add", remote, url],
            environment,
          ),
        { discard: true },
      );
    }
  },
);

function nonemptyLines(source: string) {
  return source.split("\n").map((value) => value.trim()).filter(Boolean);
}

const TrustJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean));
const reconcilePiTrust = Effect.fn("agentos.prepareHome.reconcileTrust")(
  function*(trustFile: string, trustedPaths: ReadonlyArray<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(trustFile).pipe(Effect.result);
    const trust = Result.isSuccess(source)
      ? yield* Schema.decodeUnknownEffect(TrustJson)(source.success).pipe(
        Effect.mapError((cause) => prepareError(`Invalid Pi trust file ${trustFile}.`, cause)),
      )
      : source.failure.reason._tag === "NotFound"
      ? {}
      : yield* source.failure;
    const nextTrust = { ...trust };
    for (const path of trustedPaths) nextTrust[path] = true;
    const encoded = yield* Schema.encodeEffect(TrustJson)(nextTrust).pipe(
      Effect.mapError((cause) => prepareError(`Could not encode Pi trust file ${trustFile}.`, cause)),
    );
    const next = `${trustFile}.agentos-next`;
    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(next, `${encoded}\n`, { mode: 0o600 });
      yield* fileSystem.chmod(next, 0o600);
      yield* fileSystem.rename(next, trustFile);
    }).pipe(Effect.ensuring(fileSystem.remove(next, { force: true }).pipe(Effect.ignore)));
  },
);

const runCommand = Effect.fn("agentos.prepareHome.command")(function*(
  arguments_: ReadonlyArray<string>,
  environment: DistributionEnvironment,
) {
  const [command, ...args] = arguments_;
  if (command === undefined) return yield* prepareError("Cannot run an empty command.");
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, args, {
      env: { ...environment },
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(Effect.mapError((cause) => prepareError(`Could not start ${command}.`, cause)));
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError((cause) => prepareError(`Could not collect ${command} output.`, cause)),
    );
    if (exitCode !== 0) {
      return yield* prepareError(
        `${arguments_.join(" ")} failed with status ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      );
    }
    return stdout;
  }));
});

const reportFailure = (error: unknown) => Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const message = error instanceof Error ? error.message : String(error);
  yield* Stream.make(`${message}\n`).pipe(Stream.run(stdio.stderr()), Effect.ignore);
});

if (import.meta.main) {
  BunRuntime.runMain(
    prepareHome.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(AgentOSIdentifier.layer),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
