import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { isDeepStrictEqual } from "node:util";

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

export const CODEX_GATEWAY_PROVIDER_ID = "agentos-gateway";
const providerId = CODEX_GATEWAY_PROVIDER_ID;
const markerVersion = 1;
const defaultTokenFile = "/var/run/secrets/agentos-egress/token";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const GatewayProviderEntry = Schema.Struct({
  name: Schema.Literal("AgentOS workload gateway"),
  base_url: Schema.String,
  wire_api: Schema.Literal("responses"),
  supports_websockets: Schema.Literal(false),
  request_max_retries: Schema.Literal(0),
  stream_max_retries: Schema.Literal(0),
  env_http_headers: Schema.Struct({
    "X-AgentOS-Assignment-Id": Schema.Literal("AGENTOS_ASSIGNMENT_ID"),
  }),
  auth: Schema.Struct({
    command: Schema.String,
    args: Schema.Array(Schema.String),
    timeout_ms: Schema.Literal(5_000),
    refresh_interval_ms: Schema.Literal(60_000),
  }),
});

class ActiveMarker extends Schema.TaggedClass<ActiveMarker>()("Active", {
  entry: JsonObject,
  previousModelProvider: Schema.NullOr(Schema.String),
  version: Schema.Literal(markerVersion),
}) {}

class PendingMarker extends Schema.TaggedClass<PendingMarker>()("Pending", {
  current: Schema.NullOr(JsonObject),
  desired: Schema.NullOr(JsonObject),
  previousModelProvider: Schema.NullOr(Schema.String),
  version: Schema.Literal(markerVersion),
}) {}

const ProviderMarker = Schema.Union([ActiveMarker, PendingMarker]);

type JsonObject = typeof JsonObject.Type;
type GatewayProviderEntry = typeof GatewayProviderEntry.Type;
type ProviderMarker = typeof ProviderMarker.Type;
export type CodexProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;
type Environment = CodexProviderEnvironment;
type ProviderMode = "ai-gateway" | "direct" | undefined;

export class CodexProviderConfigurationError extends Schema.TaggedErrorClass<CodexProviderConfigurationError>()(
  "CodexProviderConfigurationError",
  { message: Schema.String },
) {}

export class CodexProviderFileError extends Schema.TaggedErrorClass<CodexProviderFileError>()(
  "CodexProviderFileError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

export interface ReconcileCodexProviderOptions {
  readonly configPath: string;
  readonly environment: Environment;
  readonly stateDirectory: string;
}

export interface CodexProviderPathRuntime {
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: ReadonlyArray<string>) => string;
}

const CodexProviderLive = Layer.merge(
  BunFileSystem.layer,
  BunPath.layer,
);

function configurationError(message: string) {
  return CodexProviderConfigurationError.make({ message });
}

function fileError(operation: string, path: string, cause: unknown) {
  return CodexProviderFileError.make({
    cause,
    message: `Could not ${operation} ${path}`,
    operation,
    path,
  });
}

function optionalEnvironment(
  environment: Environment,
  name: string,
) {
  const raw = environment[name];
  if (raw === undefined) return Effect.succeed<string | undefined>(undefined);
  const value = raw.trim();
  return value
    ? Effect.succeed<string | undefined>(value)
    : Effect.fail(configurationError(`${name} must be non-empty`));
}

const providerMode = Effect.fn("agentos.codexProvider.mode")(
  function*(environment: Environment) {
    const mode = yield* optionalEnvironment(
      environment,
      "AGENTOS_CODEX_PROVIDER_MODE",
    );
    if (mode === undefined || mode === "ai-gateway" || mode === "direct") {
      return mode satisfies ProviderMode;
    }
    return yield* configurationError(
      "AGENTOS_CODEX_PROVIDER_MODE must be ai-gateway or direct",
    );
  },
);

const normalizedGatewayUrl = Effect.fn("agentos.codexProvider.gatewayUrl")(
  function*(raw: string) {
    const url = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.URLFromString)(raw),
    );
    if (url === undefined) {
      return yield* configurationError("AI_GATEWAY_URL must be an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* configurationError(
        "AI_GATEWAY_URL must use http or https",
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      return yield* configurationError(
        "AI_GATEWAY_URL must not contain credentials, a query, or a fragment",
      );
    }
    return url.toString().replace(/\/$/, "");
  },
);

const requiredAbsolutePath = Effect.fn(
  "agentos.codexProvider.absolutePath",
)(function*(
  environment: Environment,
  paths: CodexProviderPathRuntime,
  name: string,
  fallback?: string,
) {
  const value = (yield* optionalEnvironment(environment, name)) ?? fallback;
  if (value === undefined || !paths.isAbsolute(value)) {
    return yield* configurationError(`${name} must be an absolute path`);
  }
  return value;
});

export const codexGatewayProviderEntry = Effect.fn(
  "agentos.codexProvider.gatewayEntry",
)(function*(
  environment: CodexProviderEnvironment,
  paths: CodexProviderPathRuntime,
) {
  const rawUrl = yield* optionalEnvironment(environment, "AI_GATEWAY_URL");
  if (rawUrl === undefined) {
    return yield* configurationError("AI_GATEWAY_URL must be configured");
  }
  const assignmentId = yield* optionalEnvironment(
    environment,
    "AGENTOS_ASSIGNMENT_ID",
  );
  if (
    assignmentId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      assignmentId,
    )
  ) {
    return yield* configurationError(
      "AGENTOS_ASSIGNMENT_ID must be a UUID v4 in Gateway mode",
    );
  }
  const home = yield* requiredAbsolutePath(environment, paths, "HOME");
  const releaseRoot = yield* requiredAbsolutePath(
    environment,
    paths,
    "AGENTOS_RELEASE_ROOT",
  );
  const tokenFile = yield* requiredAbsolutePath(
    environment,
    paths,
    "AGENTOS_EGRESS_TOKEN_FILE",
    defaultTokenFile,
  );
  const entry = {
    name: "AgentOS workload gateway",
    base_url: yield* normalizedGatewayUrl(rawUrl),
    wire_api: "responses",
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    env_http_headers: {
      "X-AgentOS-Assignment-Id": "AGENTOS_ASSIGNMENT_ID",
    },
    auth: {
      command: paths.join(home, ".local", "share", "mise", "shims", "bun"),
      args: [
        paths.join(
          releaseRoot,
          "packages",
          "agentos",
          "runtime",
          "codex-token.ts",
        ),
        tokenFile,
      ],
      timeout_ms: 5_000,
      refresh_interval_ms: 60_000,
    },
  };
  return yield* Schema.decodeUnknownEffect(GatewayProviderEntry)(entry).pipe(
    Effect.mapError(() => configurationError("Invalid workload Gateway provider")),
  );
});

const readOptionalText = Effect.fn("agentos.codexProvider.readOptionalText")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const result = yield* fileSystem.readFileString(path).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    if (result.failure.reason._tag === "NotFound") return "";
    return yield* fileError("read", path, result.failure);
  },
);

const readMarker = Effect.fn("agentos.codexProvider.readMarker")(
  function*(path: string) {
    const source = yield* readOptionalText(path);
    if (!source) return undefined;
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ProviderMarker),
    )(source).pipe(
      Effect.mapError(() => configurationError("codex-provider.json is invalid")),
    );
  },
);

const parseConfig = Effect.fn("agentos.codexProvider.parseConfig")(
  function*(source: string) {
    const parsed = yield* Effect.try({
      try: () => Bun.TOML.parse(source),
      catch: () => configurationError("Codex config.toml is invalid"),
    });
    const root = objectValue(parsed);
    if (root === undefined) {
      return yield* configurationError("Codex config.toml is invalid");
    }
    const rawSelected = root.model_provider;
    if (rawSelected !== undefined && typeof rawSelected !== "string") {
      return yield* configurationError(
        "Codex model_provider must be a string",
      );
    }
    const providers = objectValue(root.model_providers);
    const entry = objectValue(providers?.[providerId]);
    if (providers?.[providerId] !== undefined && entry === undefined) {
      return yield* configurationError(
        `${providerId} provider is not a table`,
      );
    }
    return {
      entry,
      selected: typeof rawSelected === "string" ? rawSelected : undefined,
    };
  },
);

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function markerPrevious(marker: ProviderMarker): string | undefined {
  return marker.previousModelProvider ?? undefined;
}

function assertOwned(
  state: { entry: JsonObject | undefined; selected: string | undefined },
  marker: ProviderMarker,
) {
  if (marker._tag === "Active") {
    return state.selected === providerId &&
        isDeepStrictEqual(state.entry, marker.entry)
      ? Effect.void
      : Effect.fail(configurationError(
        `${providerId} provider changed outside AgentOS ownership`,
      ));
  }
  const matches = (entry: JsonObject | null) =>
    isDeepStrictEqual(state.entry ?? null, entry) &&
    state.selected === (entry === null ? markerPrevious(marker) : providerId);
  return matches(marker.current) || matches(marker.desired)
    ? Effect.void
    : Effect.fail(configurationError(
      `${providerId} provider changed during AgentOS reconciliation`,
    ));
}

const writePrivate = Effect.fn("agentos.codexProvider.writePrivate")(
  function*(path: string, contents: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const temporary = `${path}.agentos-next`;
    yield* fileSystem.makeDirectory(paths.dirname(path), {
      mode: 0o700,
      recursive: true,
    }).pipe(Effect.mapError((cause) => fileError("write", path, cause)));
    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(temporary, contents, { mode: 0o600 });
      yield* fileSystem.chmod(temporary, 0o600);
      yield* fileSystem.rename(temporary, path);
    }).pipe(
      Effect.mapError((cause) => fileError("write", path, cause)),
      Effect.ensuring(
        fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
      ),
    );
  },
);

function writeMarker(path: string, marker: ProviderMarker) {
  return Schema.encodeEffect(Schema.fromJsonString(ProviderMarker))(marker).pipe(
    Effect.mapError(() => configurationError("Could not encode provider marker")),
    Effect.flatMap((source) => writePrivate(path, `${source}\n`)),
  );
}

const removeMarker = Effect.fn("agentos.codexProvider.removeMarker")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(path, { force: true }).pipe(
      Effect.mapError((cause) => fileError("remove", path, cause)),
    );
  },
);

function renderConfig(
  source: string,
  selected: string | undefined,
  entry: GatewayProviderEntry | undefined,
): string {
  const preserved = removeManagedProvider(source).trim();
  const blocks: string[] = [];
  if (selected !== undefined) {
    blocks.push(`model_provider = ${JSON.stringify(selected)}`);
  }
  if (preserved) blocks.push(preserved);
  if (entry !== undefined) blocks.push(renderProvider(entry));
  return `${blocks.join("\n\n")}\n`;
}

function removeManagedProvider(source: string): string {
  let tableSeen = false;
  let managedTable = false;
  const kept: string[] = [];
  for (const line of source.split("\n")) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      tableSeen = true;
      const name = header[1]?.trim() ?? "";
      managedTable =
        name === `model_providers.${providerId}` ||
        name.startsWith(`model_providers.${providerId}.`);
    }
    if (managedTable) continue;
    if (!tableSeen && /^\s*model_provider\s*=/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function renderProvider(entry: GatewayProviderEntry): string {
  return [
    `[model_providers.${providerId}]`,
    `name = ${JSON.stringify(entry.name)}`,
    `base_url = ${JSON.stringify(entry.base_url)}`,
    `wire_api = ${JSON.stringify(entry.wire_api)}`,
    `supports_websockets = ${entry.supports_websockets}`,
    `request_max_retries = ${entry.request_max_retries}`,
    `stream_max_retries = ${entry.stream_max_retries}`,
    `env_http_headers = { "X-AgentOS-Assignment-Id" = "AGENTOS_ASSIGNMENT_ID" }`,
    "",
    `[model_providers.${providerId}.auth]`,
    `command = ${JSON.stringify(entry.auth.command)}`,
    `args = ${JSON.stringify(entry.auth.args)}`,
    `timeout_ms = ${entry.auth.timeout_ms}`,
    `refresh_interval_ms = ${entry.auth.refresh_interval_ms}`,
  ].join("\n");
}

export const reconcileCodexProviderConfigurationEffect = Effect.fn(
  "agentos.codexProvider.reconcile.effect",
)(function*(options: ReconcileCodexProviderOptions) {
  const paths = yield* Path.Path;
  const markerPath = paths.join(options.stateDirectory, "codex-provider.json");
  const mode = yield* providerMode(options.environment);
  const [source, marker] = yield* Effect.all([
    readOptionalText(options.configPath),
    readMarker(markerPath),
  ]);
  if (mode === undefined) {
    if (marker !== undefined) {
      return yield* configurationError(
        "AGENTOS_CODEX_PROVIDER_MODE must remain configured until direct rollback completes",
      );
    }
    return;
  }

  const state = yield* parseConfig(source);
  if (marker === undefined && state.entry !== undefined) {
    return yield* configurationError(
      `${providerId} provider is not owned by AgentOS`,
    );
  }
  if (marker !== undefined) yield* assertOwned(state, marker);

  const previous = marker === undefined
    ? state.selected
    : markerPrevious(marker);
  if (mode === "direct") {
    if (marker === undefined) return;
    const pending = PendingMarker.make({
      current: state.entry ?? null,
      desired: null,
      previousModelProvider: previous ?? null,
      version: markerVersion,
    });
    yield* writeMarker(markerPath, pending);
    yield* writePrivate(
      options.configPath,
      renderConfig(source, previous, undefined),
    );
    yield* removeMarker(markerPath);
    return;
  }

  const desired = yield* codexGatewayProviderEntry(
    options.environment,
    paths,
  );
  const next = renderConfig(source, providerId, desired);
  if (
    marker?._tag === "Active" &&
    isDeepStrictEqual(marker.entry, desired) &&
    source === next
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.chmod(options.configPath, 0o600).pipe(
      Effect.mapError((cause) => fileError("chmod", options.configPath, cause)),
    );
    return;
  }
  const pending = PendingMarker.make({
    current: state.entry ?? null,
    desired,
    previousModelProvider: previous ?? null,
    version: markerVersion,
  });
  yield* writeMarker(markerPath, pending);
  yield* writePrivate(options.configPath, next);
  yield* writeMarker(
    markerPath,
    ActiveMarker.make({
      entry: desired,
      previousModelProvider: previous ?? null,
      version: markerVersion,
    }),
  );
});

export function reconcileCodexProviderConfiguration(
  options: ReconcileCodexProviderOptions,
) {
  return reconcileCodexProviderConfigurationEffect(options).pipe(
    Effect.provide(CodexProviderLive),
  );
}
