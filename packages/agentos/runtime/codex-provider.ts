import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Effect, Schema } from "effect";

export const CODEX_GATEWAY_PROVIDER_ID = "agentos-gateway";
const providerId = CODEX_GATEWAY_PROVIDER_ID;
const markerVersion = 1;
const defaultTokenFile = "/var/run/secrets/agentos-egress/token";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

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
): string | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw configurationError(`${name} must be non-empty`);
  return value;
}

function providerMode(environment: Environment): ProviderMode {
  const mode = optionalEnvironment(environment, "AGENTOS_CODEX_PROVIDER_MODE");
  if (mode === undefined || mode === "ai-gateway" || mode === "direct") {
    return mode;
  }
  throw configurationError(
    "AGENTOS_CODEX_PROVIDER_MODE must be ai-gateway or direct",
  );
}

function normalizedGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configurationError("AI_GATEWAY_URL must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError("AI_GATEWAY_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError(
      "AI_GATEWAY_URL must not contain credentials, a query, or a fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function requiredAbsolutePath(
  environment: Environment,
  name: string,
  fallback?: string,
): string {
  const value = optionalEnvironment(environment, name) ?? fallback;
  if (!value || !isAbsolute(value)) {
    throw configurationError(`${name} must be an absolute path`);
  }
  return value;
}

export function codexGatewayProviderEntry(
  environment: CodexProviderEnvironment,
): Readonly<Record<string, unknown>> {
  const rawUrl = optionalEnvironment(environment, "AI_GATEWAY_URL");
  if (!rawUrl) throw configurationError("AI_GATEWAY_URL must be configured");
  const assignmentId = optionalEnvironment(
    environment,
    "AGENTOS_ASSIGNMENT_ID",
  );
  if (
    !assignmentId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      assignmentId,
    )
  ) {
    throw configurationError(
      "AGENTOS_ASSIGNMENT_ID must be a UUID v4 in Gateway mode",
    );
  }
  const home = requiredAbsolutePath(environment, "HOME");
  const releaseRoot = requiredAbsolutePath(
    environment,
    "AGENTOS_RELEASE_ROOT",
  );
  const tokenFile = requiredAbsolutePath(
    environment,
    "AGENTOS_EGRESS_TOKEN_FILE",
    defaultTokenFile,
  );
  return {
    name: "AgentOS workload gateway",
    base_url: normalizedGatewayUrl(rawUrl),
    wire_api: "responses",
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    env_http_headers: {
      "X-AgentOS-Assignment-Id": "AGENTOS_ASSIGNMENT_ID",
    },
    auth: {
      command: join(home, ".local", "share", "mise", "shims", "bun"),
      args: [
        join(releaseRoot, "packages", "agentos", "runtime", "codex-token.ts"),
        tokenFile,
      ],
      timeout_ms: 5_000,
      refresh_interval_ms: 60_000,
    },
  };
}

const readOptionalText = Effect.fn("agentos.codexProvider.readOptionalText")(
  function*(path: string) {
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, "utf8");
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            return "";
          }
          throw cause;
        }
      },
      catch: (cause) => fileError("read", path, cause),
    });
  },
);

const readMarker = Effect.fn("agentos.codexProvider.readMarker")(
  function*(path: string) {
    const source = yield* readOptionalText(path);
    if (!source) return undefined;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(source),
      catch: () => configurationError("codex-provider.json is invalid"),
    });
    return yield* Schema.decodeUnknownEffect(ProviderMarker)(parsed).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(configurationError("codex-provider.json is invalid"))
      ),
    );
  },
);

const parseConfig = Effect.fn("agentos.codexProvider.parseConfig")(
  function*(source: string) {
    const parsed = yield* Effect.try({
      try: () => Bun.TOML.parse(source) as Record<string, unknown>,
      catch: () => configurationError("Codex config.toml is invalid"),
    });
    const selected = parsed.model_provider;
    if (selected !== undefined && typeof selected !== "string") {
      return yield* configurationError(
        "Codex model_provider must be a string",
      );
    }
    const providers = objectValue(parsed.model_providers);
    const entry = objectValue(providers?.[providerId]);
    if (providers?.[providerId] !== undefined && entry === undefined) {
      return yield* configurationError(
        `${providerId} provider is not a table`,
      );
    }
    return { entry, selected: selected as string | undefined };
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
    if (
      state.selected !== providerId ||
      !isDeepStrictEqual(state.entry, marker.entry)
    ) {
      throw configurationError(
        `${providerId} provider changed outside AgentOS ownership`,
      );
    }
    return;
  }
  const matches = (entry: JsonObject | null) =>
    isDeepStrictEqual(state.entry ?? null, entry) &&
    state.selected === (entry === null ? markerPrevious(marker) : providerId);
  if (!matches(marker.current) && !matches(marker.desired)) {
    throw configurationError(
      `${providerId} provider changed during AgentOS reconciliation`,
    );
  }
}

const writePrivate = Effect.fn("agentos.codexProvider.writePrivate")(
  function*(path: string, contents: string) {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        const temporary = `${path}.agentos-next`;
        await writeFile(temporary, contents, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
      },
      catch: (cause) => fileError("write", path, cause),
    });
  },
);

function writeMarker(path: string, marker: ProviderMarker) {
  return writePrivate(path, `${JSON.stringify(marker, null, 2)}\n`);
}

const removeMarker = Effect.fn("agentos.codexProvider.removeMarker")(
  function*(path: string) {
    yield* Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => fileError("remove", path, cause),
    });
  },
);

function renderConfig(
  source: string,
  selected: string | undefined,
  entry: JsonObject | undefined,
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

function renderProvider(entry: JsonObject): string {
  const auth = entry.auth as JsonObject;
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
    `command = ${JSON.stringify(auth.command)}`,
    `args = ${JSON.stringify(auth.args)}`,
    `timeout_ms = ${auth.timeout_ms}`,
    `refresh_interval_ms = ${auth.refresh_interval_ms}`,
  ].join("\n");
}

export const reconcileCodexProviderConfiguration = Effect.fn(
  "agentos.codexProvider.reconcile",
)(function*(options: ReconcileCodexProviderOptions) {
  const markerPath = join(options.stateDirectory, "codex-provider.json");
  const mode = yield* Effect.try({
    try: () => providerMode(options.environment),
    catch: (cause) =>
      cause instanceof CodexProviderConfigurationError
        ? cause
        : configurationError("Invalid Codex provider mode"),
  });
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
  if (marker !== undefined) {
    yield* Effect.try({
      try: () => assertOwned(state, marker),
      catch: (cause) =>
        cause instanceof CodexProviderConfigurationError
          ? cause
          : configurationError("Invalid AgentOS Codex provider ownership"),
    });
  }

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

  const desired = yield* Effect.try({
    try: () => codexGatewayProviderEntry(options.environment),
    catch: (cause) =>
      cause instanceof CodexProviderConfigurationError
        ? cause
        : configurationError("Invalid workload Gateway provider"),
  });
  const next = renderConfig(source, providerId, desired);
  if (
    marker?._tag === "Active" &&
    isDeepStrictEqual(marker.entry, desired) &&
    source === next
  ) {
    yield* Effect.tryPromise({
      try: () => chmod(options.configPath, 0o600),
      catch: (cause) => fileError("chmod", options.configPath, cause),
    });
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
