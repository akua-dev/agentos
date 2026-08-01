import {
  KUBERNETES_SERVICE_ACCOUNT_CA_PATH,
  KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH,
  OpenFgaDeploymentV1Schema,
  type OpenFgaDeploymentV1,
} from "@akua-dev/agentos";
import {
  Config,
  Effect,
  FileSystem,
  Redacted,
  Schema,
} from "effect";

const ConfigurationField = Schema.Literals([
  "environment",
  "http",
  "limits",
  "kubernetes",
  "postgresql",
  "openfga",
  "secret_file",
  "deployment_file",
]);

export class EgressAuthorizerEntrypointError extends Schema.TaggedErrorClass<EgressAuthorizerEntrypointError>()(
  "EgressAuthorizerEntrypointError",
  {
    code: Schema.Literals([
      "invalid_configuration",
      "secret_unavailable",
      "deployment_unavailable",
    ]),
    field: ConfigurationField,
  },
) {}

const RawConfig = Config.all({
  environment: Config.string("AGENTOS_ENVIRONMENT").pipe(
    Config.withDefault(""),
  ),
  hostname: Config.string("EGRESS_AUTHZ_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  port: Config.int("EGRESS_AUTHZ_LISTEN_PORT").pipe(
    Config.withDefault(8787),
  ),
  gracefulShutdownMillis: Config.int(
    "EGRESS_AUTHZ_GRACEFUL_SHUTDOWN_MILLIS",
  ).pipe(Config.withDefault(20_000)),
  maximumConcurrentRequests: Config.int(
    "EGRESS_AUTHZ_MAX_CONCURRENT_REQUESTS",
  ).pipe(Config.withDefault(128)),
  requestTimeoutMillis: Config.int("EGRESS_AUTHZ_REQUEST_TIMEOUT_MILLIS").pipe(
    Config.withDefault(5_000),
  ),
  readinessTimeoutMillis: Config.int(
    "EGRESS_AUTHZ_READINESS_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  maximumHeaderCount: Config.int("EGRESS_AUTHZ_MAX_HEADER_COUNT").pipe(
    Config.withDefault(64),
  ),
  maximumHeaderBytes: Config.int("EGRESS_AUTHZ_MAX_HEADER_BYTES").pipe(
    Config.withDefault(32 * 1_024),
  ),
  maximumHeaderValueBytes: Config.int(
    "EGRESS_AUTHZ_MAX_HEADER_VALUE_BYTES",
  ).pipe(Config.withDefault(16 * 1_024)),
  maximumSettlementBodyBytes: Config.int(
    "EGRESS_AUTHZ_MAX_SETTLEMENT_BODY_BYTES",
  ).pipe(Config.withDefault(4 * 1_024)),
  kubernetesBaseUrl: Config.url("KUBERNETES_API_URL").pipe(
    Config.withDefault(new URL("https://kubernetes.default.svc")),
  ),
  kubernetesServiceAccountTokenPath: Config.string(
    "KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE",
  ).pipe(Config.withDefault(KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH)),
  kubernetesServiceAccountCaPath: Config.string(
    "KUBERNETES_SERVICE_ACCOUNT_CA_FILE",
  ).pipe(Config.withDefault(KUBERNETES_SERVICE_ACCOUNT_CA_PATH)),
  kubernetesTimeoutMillis: Config.int("KUBERNETES_TIMEOUT_MILLIS").pipe(
    Config.withDefault(2_000),
  ),
  kubernetesMaximumResponseBytes: Config.int(
    "KUBERNETES_MAX_RESPONSE_BYTES",
  ).pipe(Config.withDefault(256 * 1_024)),
  databaseUrlFile: Config.string("AGENTOS_DATABASE_URL_FILE").pipe(
    Config.withDefault("/var/run/secrets/agentos-egress/database-url"),
  ),
  databaseMaximumConnections: Config.int(
    "AGENTOS_DATABASE_MAX_CONNECTIONS",
  ).pipe(Config.withDefault(16)),
  databaseMinimumConnections: Config.int(
    "AGENTOS_DATABASE_MIN_CONNECTIONS",
  ).pipe(Config.withDefault(2)),
  databaseConnectTimeoutMillis: Config.int(
    "AGENTOS_DATABASE_CONNECT_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  openFgaBaseUrl: Config.url("OPENFGA_BASE_URL").pipe(
    Config.withDefault(new URL("http://openfga.agentos.svc.cluster.local:8080")),
  ),
  openFgaPresharedKeyFile: Config.string(
    "OPENFGA_PRESHARED_KEY_FILE",
  ).pipe(Config.withDefault("")),
  openFgaDeploymentDirectory: Config.string(
    "OPENFGA_DEPLOYMENT_DIRECTORY",
  ).pipe(Config.withDefault("/var/run/agentos-openfga")),
  openFgaTimeoutMillis: Config.int("OPENFGA_TIMEOUT_MILLIS").pipe(
    Config.withDefault(2_000),
  ),
  openFgaMaximumResponseBytes: Config.int(
    "OPENFGA_MAX_RESPONSE_BYTES",
  ).pipe(Config.withDefault(256 * 1_024)),
});

export interface EgressAuthorizerConfig {
  readonly environment: string | null;
  readonly hostname: string;
  readonly port: number;
  readonly gracefulShutdownMillis: number;
  readonly maximumConcurrentRequests: number;
  readonly requestTimeoutMillis: number;
  readonly readinessTimeoutMillis: number;
  readonly maximumHeaderCount: number;
  readonly maximumHeaderBytes: number;
  readonly maximumHeaderValueBytes: number;
  readonly maximumSettlementBodyBytes: number;
  readonly kubernetesBaseUrl: string;
  readonly kubernetesServiceAccountTokenPath: string;
  readonly kubernetesServiceAccountCaPath: string;
  readonly kubernetesTimeoutMillis: number;
  readonly kubernetesMaximumResponseBytes: number;
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly databaseMaximumConnections: number;
  readonly databaseMinimumConnections: number;
  readonly databaseConnectTimeoutMillis: number;
  readonly openFgaBaseUrl: string;
  readonly openFgaPresharedKey: Redacted.Redacted<string> | null;
  readonly openFgaDeployment: OpenFgaDeploymentV1;
  readonly openFgaTimeoutMillis: number;
  readonly openFgaMaximumResponseBytes: number;
}

export const loadEgressAuthorizerConfig = Effect.fn(
  "agentos.egressAuthz.loadConfig",
)(function*() {
  const raw = yield* RawConfig.pipe(
    Effect.mapError(() => configurationError("invalid_configuration", "http")),
  );
  yield* validateRawConfig(raw);
  const databaseUrl = yield* readEgressAuthorizerSecret(raw.databaseUrlFile);
  yield* validateDatabaseUrl(databaseUrl);
  const openFgaPresharedKey = raw.openFgaPresharedKeyFile === ""
    ? null
    : yield* readEgressAuthorizerSecret(raw.openFgaPresharedKeyFile);
  const openFgaDeployment = yield* readEgressAuthorizerDeployment(
    raw.openFgaDeploymentDirectory,
  );
  return {
    environment: raw.environment === "" ? null : raw.environment,
    hostname: raw.hostname,
    port: raw.port,
    gracefulShutdownMillis: raw.gracefulShutdownMillis,
    maximumConcurrentRequests: raw.maximumConcurrentRequests,
    requestTimeoutMillis: raw.requestTimeoutMillis,
    readinessTimeoutMillis: raw.readinessTimeoutMillis,
    maximumHeaderCount: raw.maximumHeaderCount,
    maximumHeaderBytes: raw.maximumHeaderBytes,
    maximumHeaderValueBytes: raw.maximumHeaderValueBytes,
    maximumSettlementBodyBytes: raw.maximumSettlementBodyBytes,
    kubernetesBaseUrl: raw.kubernetesBaseUrl.toString(),
    kubernetesServiceAccountTokenPath:
      raw.kubernetesServiceAccountTokenPath,
    kubernetesServiceAccountCaPath: raw.kubernetesServiceAccountCaPath,
    kubernetesTimeoutMillis: raw.kubernetesTimeoutMillis,
    kubernetesMaximumResponseBytes: raw.kubernetesMaximumResponseBytes,
    databaseUrl,
    databaseMaximumConnections: raw.databaseMaximumConnections,
    databaseMinimumConnections: raw.databaseMinimumConnections,
    databaseConnectTimeoutMillis: raw.databaseConnectTimeoutMillis,
    openFgaBaseUrl: raw.openFgaBaseUrl.toString(),
    openFgaPresharedKey,
    openFgaDeployment,
    openFgaTimeoutMillis: raw.openFgaTimeoutMillis,
    openFgaMaximumResponseBytes: raw.openFgaMaximumResponseBytes,
  } satisfies EgressAuthorizerConfig;
});

export const readEgressAuthorizerSecret = Effect.fn(
  "agentos.egressAuthz.readSecret",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(() =>
      configurationError("secret_unavailable", "secret_file")
    ),
  );
  if (
    source === "" || source !== source.trim() || source.length > 16 * 1_024
  ) {
    return yield* configurationError("secret_unavailable", "secret_file");
  }
  return Redacted.make(source);
});

export const readEgressAuthorizerDeployment = Effect.fn(
  "agentos.egressAuthz.readDeployment",
)(function*(directory: string) {
  const [storeId, authorizationModelId] = yield* Effect.all([
    readDeploymentValue(`${directory}/store-id`),
    readDeploymentValue(`${directory}/authorization-model-id`),
  ], { concurrency: 2 });
  return yield* Schema.decodeUnknownEffect(OpenFgaDeploymentV1Schema)({
    storeId,
    authorizationModelId,
  }).pipe(
    Effect.mapError(() =>
      configurationError("deployment_unavailable", "deployment_file")
    ),
  );
});

const readDeploymentValue = Effect.fn(
  "agentos.egressAuthz.readDeploymentValue",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(() =>
      configurationError("deployment_unavailable", "deployment_file")
    ),
  );
  const value = source.trim();
  if (value === "" || value.length > 1_024) {
    return yield* configurationError(
      "deployment_unavailable",
      "deployment_file",
    );
  }
  return value;
});

function validateRawConfig(raw: Config.Success<typeof RawConfig>) {
  const positive = [
    raw.gracefulShutdownMillis,
    raw.maximumConcurrentRequests,
    raw.requestTimeoutMillis,
    raw.readinessTimeoutMillis,
    raw.maximumHeaderCount,
    raw.maximumHeaderBytes,
    raw.maximumHeaderValueBytes,
    raw.maximumSettlementBodyBytes,
    raw.kubernetesTimeoutMillis,
    raw.kubernetesMaximumResponseBytes,
    raw.databaseMaximumConnections,
    raw.databaseConnectTimeoutMillis,
    raw.openFgaTimeoutMillis,
    raw.openFgaMaximumResponseBytes,
  ];
  const valid = raw.port >= 1 && raw.port <= 65_535 &&
    raw.hostname.length > 0 && raw.hostname.length <= 253 &&
    raw.environment.length <= 63 &&
    (raw.environment === "" ||
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(raw.environment)) &&
    positive.every((value) => Number.isSafeInteger(value) && value > 0) &&
    Number.isSafeInteger(raw.databaseMinimumConnections) &&
    raw.databaseMinimumConnections >= 0 &&
    raw.databaseMinimumConnections <= raw.databaseMaximumConnections &&
    raw.maximumHeaderValueBytes <= raw.maximumHeaderBytes &&
    raw.kubernetesBaseUrl.protocol === "https:" &&
    ["http:", "https:"].includes(raw.openFgaBaseUrl.protocol) &&
    raw.databaseUrlFile.length > 0 &&
    raw.kubernetesServiceAccountTokenPath.length > 0 &&
    raw.kubernetesServiceAccountCaPath.length > 0 &&
    raw.openFgaDeploymentDirectory.length > 0;
  return valid
    ? Effect.void
    : configurationError("invalid_configuration", "limits");
}

function validateDatabaseUrl(databaseUrl: Redacted.Redacted<string>) {
  const value = Redacted.value(databaseUrl);
  if (!URL.canParse(value)) {
    return configurationError("invalid_configuration", "postgresql");
  }
  const url = new URL(value);
  return url.protocol === "postgres:" || url.protocol === "postgresql:"
    ? Effect.void
    : configurationError("invalid_configuration", "postgresql");
}

function configurationError(
  code: EgressAuthorizerEntrypointError["code"],
  field: EgressAuthorizerEntrypointError["field"],
) {
  return EgressAuthorizerEntrypointError.make({ code, field });
}

export function safeEgressAuthorizerEntrypointFailure(error: unknown) {
  if (
    typeof error === "object" && error !== null &&
    "_tag" in error && typeof error._tag === "string"
  ) {
    return {
      error: error._tag,
      ...("code" in error && typeof error.code === "string"
        ? { code: error.code }
        : {}),
      ...("field" in error && typeof error.field === "string"
        ? { field: error.field }
        : {}),
    };
  }
  return { error: "UnknownFailure" };
}
