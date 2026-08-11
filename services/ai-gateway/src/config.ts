import {
  AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL,
  AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_PATH,
} from "@akua-dev/agentos";
import {
  Config,
  Effect,
  Redacted,
  Schema,
} from "effect";

export const defaultAIGatewayIdleTimeoutSeconds = 255;
export const defaultAIGatewayGracefulShutdownMillis = 20_000;

const RawConfig = Config.all({
  home: Config.string("HOME").pipe(Config.withDefault(".")),
  stateDirectory: Config.string("AI_GATEWAY_STATE_DIR").pipe(
    Config.withDefault(""),
  ),
  hostname: Config.string("AI_GATEWAY_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  port: Config.int("AI_GATEWAY_LISTEN_PORT").pipe(
    Config.withDefault(8787),
  ),
  idleTimeoutSeconds: Config.int("AI_GATEWAY_IDLE_TIMEOUT_SECONDS").pipe(
    Config.withDefault(defaultAIGatewayIdleTimeoutSeconds),
  ),
  gracefulShutdownMillis: Config.int(
    "AI_GATEWAY_GRACEFUL_SHUTDOWN_MILLIS",
  ).pipe(Config.withDefault(defaultAIGatewayGracefulShutdownMillis)),
  operatorToken: Config.redacted("AI_GATEWAY_OPERATOR_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  allowApiKeyFallback: Config.boolean(
    "AI_GATEWAY_ALLOW_API_KEY_FALLBACK",
  ).pipe(Config.withDefault(false)),
  openAIApiKey: Config.redacted("OPENAI_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  heartbeatMillis: Config.int("AI_GATEWAY_HEARTBEAT_MILLIS").pipe(
    Config.withDefault(40_000),
  ),
  maximumUsageEventBytes: Config.int(
    "AI_GATEWAY_MAX_USAGE_EVENT_BYTES",
  ).pipe(Config.withDefault(256 * 1_024)),
  usageCacheMillis: Config.int("AI_GATEWAY_USAGE_CACHE_MILLIS").pipe(
    Config.withDefault(60_000),
  ),
  quotaTimeoutMillis: Config.int("AI_GATEWAY_QUOTA_TIMEOUT_MILLIS").pipe(
    Config.withDefault(5_000),
  ),
  settlementBaseUrl: Config.url(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL",
  ).pipe(
    Config.withDefault(new URL(AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL)),
  ),
  settlementTokenPath: Config.string(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_FILE",
  ).pipe(Config.withDefault(AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_PATH)),
  settlementTimeoutMillis: Config.int(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  settlementMaximumResponseBytes: Config.int(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_MAX_RESPONSE_BYTES",
  ).pipe(Config.withDefault(1_024)),
});

const AIGatewayEntrypointErrorCode = Schema.Literals([
  "invalid_configuration",
  "client_identity_unavailable",
  "oauth_unavailable",
  "status_unavailable",
  "telemetry_unavailable",
  "server_unavailable",
]);

export class AIGatewayEntrypointError extends Schema.TaggedErrorClass<AIGatewayEntrypointError>()(
  "AIGatewayEntrypointError",
  { code: AIGatewayEntrypointErrorCode },
) {}

export interface AIGatewayConfig {
  readonly stateDirectory: string;
  readonly hostname: string;
  readonly port: number;
  readonly idleTimeoutSeconds: number;
  readonly gracefulShutdownMillis: number;
  readonly operatorToken: Redacted.Redacted<string>;
  readonly allowApiKeyFallback: boolean;
  readonly openAIApiKey: Redacted.Redacted<string>;
  readonly heartbeatMillis: number;
  readonly maximumUsageEventBytes: number;
  readonly usageCacheMillis: number;
  readonly quotaTimeoutMillis: number;
  readonly settlementBaseUrl: string;
  readonly settlementTokenPath: string;
  readonly settlementTimeoutMillis: number;
  readonly settlementMaximumResponseBytes: number;
}

export type AIGatewayServeAuthentication = { readonly kind: "workload_identity" };

export interface AIGatewayServeConfig extends AIGatewayConfig {
  readonly authentication: AIGatewayServeAuthentication;
  readonly operatorToken: Redacted.Redacted<string>;
}

export const loadAIGatewayConfig = Effect.fn(
  "agentos.aiGateway.loadConfig",
)(function*() {
  const raw = yield* RawConfig.pipe(
    Effect.mapError(() => aiGatewayEntrypointError("invalid_configuration")),
  );
  const stateDirectory = raw.stateDirectory === ""
    ? defaultStateDirectory(raw.home)
    : raw.stateDirectory;
  if (!validConfiguration(raw, stateDirectory)) {
    return yield* aiGatewayEntrypointError("invalid_configuration");
  }
  return {
    stateDirectory,
    hostname: raw.hostname,
    port: raw.port,
    idleTimeoutSeconds: raw.idleTimeoutSeconds,
    gracefulShutdownMillis: raw.gracefulShutdownMillis,
    operatorToken: raw.operatorToken,
    allowApiKeyFallback: raw.allowApiKeyFallback,
    openAIApiKey: raw.openAIApiKey,
    heartbeatMillis: raw.heartbeatMillis,
    maximumUsageEventBytes: raw.maximumUsageEventBytes,
    usageCacheMillis: raw.usageCacheMillis,
    quotaTimeoutMillis: raw.quotaTimeoutMillis,
    settlementBaseUrl: raw.settlementBaseUrl.toString(),
    settlementTokenPath: raw.settlementTokenPath,
    settlementTimeoutMillis: raw.settlementTimeoutMillis,
    settlementMaximumResponseBytes: raw.settlementMaximumResponseBytes,
  } satisfies AIGatewayConfig;
});

export const requireAIGatewayServeConfig = Effect.fn(
  "agentos.aiGateway.requireServeConfig",
)(function*(config: AIGatewayConfig) {
  const operatorToken = config.operatorToken;
  const authentication: AIGatewayServeAuthentication = { kind: "workload_identity" };
  return {
    ...config,
    authentication,
    operatorToken,
  } satisfies AIGatewayServeConfig;
});

function validConfiguration(
  raw: Config.Success<typeof RawConfig>,
  stateDirectory: string,
): boolean {
  const operatorToken = Redacted.value(raw.operatorToken);
  const openAIApiKey = Redacted.value(raw.openAIApiKey);
  return (
    validString(raw.hostname, 253) &&
    validPath(stateDirectory) &&
    validPath(raw.settlementTokenPath) &&
    validSecret(operatorToken) &&
    validSecret(openAIApiKey) &&
    validPositiveInteger(raw.port, 65_535) &&
    validNonNegativeInteger(raw.idleTimeoutSeconds, 255) &&
    validPositiveInteger(raw.gracefulShutdownMillis) &&
    validPositiveInteger(raw.heartbeatMillis) &&
    validPositiveInteger(raw.maximumUsageEventBytes) &&
    validPositiveInteger(raw.usageCacheMillis) &&
    validPositiveInteger(raw.quotaTimeoutMillis) &&
    validPositiveInteger(raw.settlementTimeoutMillis) &&
    validPositiveInteger(raw.settlementMaximumResponseBytes) &&
    validSettlementBaseUrl(raw.settlementBaseUrl)
  );
}

function defaultStateDirectory(home: string): string {
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return `${base}/.local/state/ai-gateway`;
}

function validPositiveInteger(value: number, maximum?: number): boolean {
  return Number.isSafeInteger(value) && value > 0 &&
    (maximum === undefined || value <= maximum);
}

function validNonNegativeInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validString(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value === value.trim();
}

function validPath(value: string): boolean {
  return validString(value, 4_096);
}

function validSecret(value: string): boolean {
  return value.length <= 16 * 1_024 && value === value.trim();
}

function validSettlementBaseUrl(value: URL): boolean {
  return (
    ["http:", "https:"].includes(value.protocol) &&
    value.username === "" &&
    value.password === "" &&
    ["", "/"].includes(value.pathname) &&
    value.search === "" &&
    value.hash === ""
  );
}

export function aiGatewayEntrypointError(
  code: AIGatewayEntrypointError["code"],
) {
  return AIGatewayEntrypointError.make({ code });
}
