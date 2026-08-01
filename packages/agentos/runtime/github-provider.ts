import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";

const WRAPPER_MARKER = "# agentos-managed github-workload-wrapper-v1";
const INCLUDE_BEGIN = "# agentos-github-broker-include-begin";
const INCLUDE_END = "# agentos-github-broker-include-end";
const AssignmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const GitHubProviderErrorCode = Schema.Literals([
  "filesystem_failure",
  "invalid_configuration",
  "managed_state_collision",
]);

export class GitHubProviderConfigurationError extends Schema.TaggedErrorClass<
  GitHubProviderConfigurationError
>()("GitHubProviderConfigurationError", {
  code: GitHubProviderErrorCode,
  path: Schema.NullOr(Schema.String),
}) {}

export const GitHubProviderConfig = Config.all({
  assignmentId: Config.string("AGENTOS_ASSIGNMENT_ID").pipe(Config.option),
  caFile: Config.string("AGENTOS_GITHUB_CA_FILE").pipe(Config.option),
  endpoint: Config.url("AGENTOS_GITHUB_ENDPOINT").pipe(Config.option),
  host: Config.string("AGENTOS_GITHUB_HOST").pipe(Config.option),
  mode: Config.literals(
    ["broker", "direct"],
    "AGENTOS_GITHUB_PROVIDER_MODE",
  ).pipe(Config.option),
  tokenFile: Config.string("AGENTOS_EGRESS_TOKEN_FILE").pipe(Config.option),
});

export const reconcileGitHubProviderConfiguration = Effect.fn(
  "agentos.runtime.reconcileGitHubProvider",
)(function*(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}) {
  const environment = Object.fromEntries(
    Object.entries(options.environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const config = yield* GitHubProviderConfig.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({
        env: environment,
      })),
    ),
    Effect.mapError(() => providerError("invalid_configuration", null)),
  );
  yield* reconcileGitHubProviderConfigurationValue({
    config,
    home: options.home,
  });
});

export const reconcileGitHubProviderConfigurationValue = Effect.fn(
  "agentos.runtime.reconcileGitHubProviderValue",
)(function*(options: {
  readonly config: Config.Success<typeof GitHubProviderConfig>;
  readonly home: string;
}) {
  const config = options.config;
  const mode = Option.getOrUndefined(config.mode);
  if (mode === undefined) return;

  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const configDirectory = paths.join(options.home, ".config", "agentos");
  const binDirectory = paths.join(options.home, ".local", "bin");
  const stateDirectory = paths.join(
    options.home,
    ".local",
    "state",
    "agentos",
  );
  const githubCliDirectory = paths.join(stateDirectory, "github-cli");
  const managedConfig = paths.join(
    configDirectory,
    "github-broker.gitconfig",
  );
  const gitconfig = paths.join(options.home, ".gitconfig");
  const marker = paths.join(stateDirectory, "github-provider.json");

  yield* Effect.all([
    makePrivateDirectory(fileSystem, configDirectory),
    makePrivateDirectory(fileSystem, binDirectory),
    makePrivateDirectory(fileSystem, stateDirectory),
    makePrivateDirectory(fileSystem, githubCliDirectory),
  ], { concurrency: "unbounded" });

  if (mode === "direct") {
    yield* Effect.all([
      removeOwnedWrapper(fileSystem, paths.join(binDirectory, "gh")),
      removeOwnedWrapper(fileSystem, paths.join(binDirectory, "gh-axi")),
    ], { concurrency: "unbounded" });
    yield* fileSystem.remove(managedConfig, { force: true }).pipe(
      mapFileError(managedConfig),
    );
    yield* reconcileGitInclude(fileSystem, paths, gitconfig, managedConfig, false);
    yield* atomicWrite(
      fileSystem,
      paths,
      marker,
      `${JSON.stringify({
        schemaVersion: 1,
        owner: "agentos-github-provider-v1",
        state: "direct",
      }, null, 2)}\n`,
      0o600,
    );
    return;
  }

  const endpoint = yield* requiredOption(config.endpoint);
  const host = (yield* requiredOption(config.host)).toLowerCase();
  const tokenFile = yield* requiredOption(config.tokenFile);
  const caFile = yield* requiredOption(config.caFile);
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
    endpoint.hostname !== host ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.length > 253
  ) {
    return yield* providerError("invalid_configuration", null);
  }
  const assignmentId = Option.getOrUndefined(config.assignmentId);
  if (assignmentId !== undefined && !AssignmentPattern.test(assignmentId)) {
    return yield* providerError("invalid_configuration", null);
  }

  yield* Effect.all([
    writeOwnedWrapper(
      fileSystem,
      paths,
      paths.join(binDirectory, "gh"),
      "gh",
    ),
    writeOwnedWrapper(
      fileSystem,
      paths,
      paths.join(binDirectory, "gh-axi"),
      "gh-axi",
    ),
  ], { concurrency: "unbounded" });
  const managed = [
    `[url "${endpoint.toString()}"]`,
    "\tinsteadOf = https://github.com/",
    `[credential "${endpoint.toString().replace(/\/$/, "")}"]`,
    "\thelper =",
    "\thelper = !/usr/local/bin/agentos-github-workload-auth credential",
    "\tuseHttpPath = true",
    `[http "${endpoint.toString().replace(/\/$/, "")}"]`,
    `\tsslCAInfo = ${caFile}`,
    ...(assignmentId === undefined
      ? []
      : [`\textraHeader = X-AgentOS-Assignment-ID: ${assignmentId}`]),
    "",
  ].join("\n");
  yield* atomicWrite(fileSystem, paths, managedConfig, managed, 0o600);
  yield* reconcileGitInclude(fileSystem, paths, gitconfig, managedConfig, true);
  yield* atomicWrite(
    fileSystem,
    paths,
    marker,
    `${JSON.stringify({
      schemaVersion: 1,
      owner: "agentos-github-provider-v1",
      state: "active",
      endpoint: endpoint.toString().replace(/\/$/, ""),
      host,
      projectedTokenFile: tokenFile,
    }, null, 2)}\n`,
    0o600,
  );
});

function writeOwnedWrapper(
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  path: string,
  tool: "gh" | "gh-axi",
) {
  return Effect.gen(function*() {
    const current = yield* readOptional(fileSystem, path);
    if (current !== undefined && !current.includes(WRAPPER_MARKER)) {
      return yield* providerError("managed_state_collision", path);
    }
    yield* atomicWrite(
      fileSystem,
      paths,
      path,
      [
        "#!/bin/sh",
        WRAPPER_MARKER,
        `exec /usr/local/bin/agentos-github-workload-auth exec ${tool} "$@"`,
        "",
      ].join("\n"),
      0o700,
    );
  });
}

function removeOwnedWrapper(
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  return Effect.gen(function*() {
    const current = yield* readOptional(fileSystem, path);
    if (current?.includes(WRAPPER_MARKER)) {
      yield* fileSystem.remove(path, { force: true }).pipe(mapFileError(path));
    }
  });
}

function reconcileGitInclude(
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  gitconfig: string,
  managedConfig: string,
  enabled: boolean,
) {
  return Effect.gen(function*() {
    const current = (yield* readOptional(fileSystem, gitconfig)) ?? "";
    const begin = current.indexOf(INCLUDE_BEGIN);
    const end = current.indexOf(INCLUDE_END);
    if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) {
      return yield* providerError("managed_state_collision", gitconfig);
    }
    const without = begin < 0
      ? current
      : `${current.slice(0, begin)}${current.slice(
        end + INCLUDE_END.length,
      ).replace(/^\n/, "")}`;
    const normalized = without.length === 0 || without.endsWith("\n")
      ? without
      : `${without}\n`;
    const next = enabled
      ? `${normalized}${INCLUDE_BEGIN}\n[include]\n\tpath = ${managedConfig}\n${INCLUDE_END}\n`
      : normalized;
    if (next.length === 0 && !(yield* fileSystem.exists(gitconfig).pipe(
      mapFileError(gitconfig),
    ))) return;
    yield* atomicWrite(fileSystem, paths, gitconfig, next, 0o600);
  });
}

function atomicWrite(
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  path: string,
  contents: string,
  mode: number,
) {
  return Effect.gen(function*() {
    yield* makePrivateDirectory(fileSystem, paths.dirname(path));
    const next = `${path}.agentos-next`;
    yield* fileSystem.remove(next, { force: true }).pipe(mapFileError(next));
    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(next, contents, { flag: "wx", mode });
      yield* fileSystem.chmod(next, mode);
      yield* fileSystem.rename(next, path);
    }).pipe(
      Effect.mapError(() => providerError("filesystem_failure", path)),
      Effect.ensuring(
        fileSystem.remove(next, { force: true }).pipe(Effect.ignore),
      ),
    );
  });
}

function readOptional(
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  return Effect.gen(function*() {
    const exists = yield* fileSystem.exists(path).pipe(mapFileError(path));
    return exists
      ? yield* fileSystem.readFileString(path).pipe(mapFileError(path))
      : undefined;
  });
}

function makePrivateDirectory(
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  return fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 }).pipe(
    mapFileError(path),
  );
}

function mapFileError(path: string) {
  return Effect.mapError(() => providerError("filesystem_failure", path));
}

function requiredOption<A>(value: Option.Option<A>) {
  return Option.match(value, {
    onNone: () => Effect.fail(providerError("invalid_configuration", null)),
    onSome: Effect.succeed,
  });
}

function providerError(
  code: GitHubProviderConfigurationError["code"],
  path: string | null,
) {
  return GitHubProviderConfigurationError.make({ code, path });
}
