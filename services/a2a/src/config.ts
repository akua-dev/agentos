import {
  KUBERNETES_SERVICE_ACCOUNT_CA_PATH,
  KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH,
  OpenFgaDeploymentV1Schema,
  type OpenFgaDeploymentV1,
} from "@akua-dev/agentos";
import { Config, Effect, FileSystem, Redacted, Schema } from "effect";

import { A2aTargetDefinitionV1Schema } from "./app.ts";

const ConfigurationFieldSchema = Schema.Literals([
  "deployment_file",
  "http",
  "kubernetes",
  "limits",
  "openfga",
  "postgresql",
  "secret_file",
  "target_directory",
]);

export class A2aEntrypointError extends Schema.TaggedErrorClass<A2aEntrypointError>()(
  "A2aEntrypointError",
  {
    code: Schema.Literals([
      "deployment_unavailable",
      "invalid_configuration",
      "secret_unavailable",
      "target_directory_unavailable",
    ]),
    field: ConfigurationFieldSchema,
  },
) {}

const RawConfig = Config.all({
  environment: Config.string("AGENTOS_ENVIRONMENT").pipe(
    Config.withDefault(""),
  ),
  hostname: Config.string("A2A_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  port: Config.int("A2A_LISTEN_PORT").pipe(Config.withDefault(8_790)),
  gracefulShutdownMillis: Config.int(
    "A2A_GRACEFUL_SHUTDOWN_MILLIS",
  ).pipe(Config.withDefault(20_000)),
  maximumBodyBytes: Config.int("A2A_MAXIMUM_BODY_BYTES").pipe(
    Config.withDefault(16 * 1_024),
  ),
  requestTimeoutMillis: Config.int("A2A_REQUEST_TIMEOUT_MILLIS").pipe(
    Config.withDefault(5_000),
  ),
  baseUrl: Config.url("A2A_BASE_URL").pipe(
    Config.withDefault(
      new URL("https://agentgateway.agentos.svc.cluster.local"),
    ),
  ),
  targetDirectoryFile: Config.string("A2A_TARGET_DIRECTORY_FILE").pipe(
    Config.withDefault("/etc/agentos-a2a/targets.json"),
  ),
  databaseUrlFile: Config.string("AGENTOS_DATABASE_URL_FILE").pipe(
    Config.withDefault("/var/run/secrets/agentos-a2a/database-url"),
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
  kubernetesBaseUrl: Config.url("KUBERNETES_API_URL").pipe(
    Config.withDefault(new URL("https://kubernetes.default.svc")),
  ),
  kubernetesServiceAccountTokenPath: Config.string(
    "KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE",
  ).pipe(Config.withDefault(KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH)),
  kubernetesServiceAccountCaPath: Config.string(
    "KUBERNETES_SERVICE_ACCOUNT_CA_FILE",
  ).pipe(Config.withDefault(KUBERNETES_SERVICE_ACCOUNT_CA_PATH)),
  kubernetesReadinessTokenPath: Config.string(
    "A2A_READINESS_TOKEN_FILE",
  ).pipe(Config.withDefault("/var/run/secrets/agentos-a2a/token")),
  kubernetesNamespace: Config.string("A2A_KUBERNETES_NAMESPACE").pipe(
    Config.withDefault("agentos"),
  ),
  kubernetesServiceAccountName: Config.string(
    "A2A_KUBERNETES_SERVICE_ACCOUNT",
  ).pipe(Config.withDefault("agentos-a2a")),
  kubernetesTimeoutMillis: Config.int("KUBERNETES_TIMEOUT_MILLIS").pipe(
    Config.withDefault(2_000),
  ),
  kubernetesMaximumResponseBytes: Config.int(
    "KUBERNETES_MAX_RESPONSE_BYTES",
  ).pipe(Config.withDefault(256 * 1_024)),
  openFgaBaseUrl: Config.url("OPENFGA_BASE_URL").pipe(
    Config.withDefault(
      new URL("http://openfga.agentos.svc.cluster.local:8080"),
    ),
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

export interface A2aServiceConfig {
  readonly environment: string | null;
  readonly hostname: string;
  readonly port: number;
  readonly gracefulShutdownMillis: number;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMillis: number;
  readonly baseUrl: string;
  readonly targets: ReadonlyArray<
    typeof A2aTargetDefinitionV1Schema.Type
  >;
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly databaseMaximumConnections: number;
  readonly databaseMinimumConnections: number;
  readonly databaseConnectTimeoutMillis: number;
  readonly kubernetesBaseUrl: string;
  readonly kubernetesServiceAccountTokenPath: string;
  readonly kubernetesServiceAccountCaPath: string;
  readonly kubernetesReadinessTokenPath: string;
  readonly kubernetesNamespace: string;
  readonly kubernetesServiceAccountName: string;
  readonly kubernetesTimeoutMillis: number;
  readonly kubernetesMaximumResponseBytes: number;
  readonly openFgaBaseUrl: string;
  readonly openFgaPresharedKey: Redacted.Redacted<string> | null;
  readonly openFgaDeployment: OpenFgaDeploymentV1;
  readonly openFgaTimeoutMillis: number;
  readonly openFgaMaximumResponseBytes: number;
}

export const loadA2aServiceConfig = Effect.fn("agentos.a2a.loadConfig")(
  function*() {
    const raw = yield* RawConfig.pipe(
      Effect.mapError(() => configError("invalid_configuration", "http")),
    );
    yield* validateRawConfig(raw);
    const [databaseUrl, targets, openFgaDeployment, openFgaPresharedKey] =
      yield* Effect.all([
        readA2aSecret(raw.databaseUrlFile),
        readA2aTargetDirectory(raw.targetDirectoryFile),
        readA2aOpenFgaDeployment(raw.openFgaDeploymentDirectory),
        raw.openFgaPresharedKeyFile === ""
          ? Effect.succeed(null)
          : readA2aSecret(raw.openFgaPresharedKeyFile),
      ], { concurrency: 4 });
    yield* validateDatabaseUrl(databaseUrl);
    return {
      environment: raw.environment === "" ? null : raw.environment,
      hostname: raw.hostname,
      port: raw.port,
      gracefulShutdownMillis: raw.gracefulShutdownMillis,
      maximumBodyBytes: raw.maximumBodyBytes,
      requestTimeoutMillis: raw.requestTimeoutMillis,
      baseUrl: raw.baseUrl.toString().replace(/\/$/, ""),
      targets,
      databaseUrl,
      databaseMaximumConnections: raw.databaseMaximumConnections,
      databaseMinimumConnections: raw.databaseMinimumConnections,
      databaseConnectTimeoutMillis: raw.databaseConnectTimeoutMillis,
      kubernetesBaseUrl: raw.kubernetesBaseUrl.toString(),
      kubernetesServiceAccountTokenPath:
        raw.kubernetesServiceAccountTokenPath,
      kubernetesServiceAccountCaPath: raw.kubernetesServiceAccountCaPath,
      kubernetesReadinessTokenPath: raw.kubernetesReadinessTokenPath,
      kubernetesNamespace: raw.kubernetesNamespace,
      kubernetesServiceAccountName: raw.kubernetesServiceAccountName,
      kubernetesTimeoutMillis: raw.kubernetesTimeoutMillis,
      kubernetesMaximumResponseBytes: raw.kubernetesMaximumResponseBytes,
      openFgaBaseUrl: raw.openFgaBaseUrl.toString(),
      openFgaPresharedKey,
      openFgaDeployment,
      openFgaTimeoutMillis: raw.openFgaTimeoutMillis,
      openFgaMaximumResponseBytes: raw.openFgaMaximumResponseBytes,
    } satisfies A2aServiceConfig;
  },
);

export const readA2aSecret = Effect.fn("agentos.a2a.readSecret")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(() => configError("secret_unavailable", "secret_file")),
    );
    if (
      source === "" || source !== source.trim() ||
      source.length > 16 * 1_024
    ) {
      return yield* configError("secret_unavailable", "secret_file");
    }
    return Redacted.make(source);
  },
);

export const readA2aOpenFgaDeployment = Effect.fn(
  "agentos.a2a.readOpenFgaDeployment",
)(function*(directory: string) {
  const [storeId, authorizationModelId] = yield* Effect.all([
    readDeploymentValue(`${directory}/store-id`),
    readDeploymentValue(`${directory}/authorization-model-id`),
  ], { concurrency: 2 });
  return yield* Schema.decodeUnknownEffect(OpenFgaDeploymentV1Schema, {
    onExcessProperty: "error",
  })({ storeId, authorizationModelId }).pipe(
    Effect.mapError(() =>
      configError("deployment_unavailable", "deployment_file")
    ),
  );
});

export const readA2aTargetDirectory = Effect.fn(
  "agentos.a2a.readTargetDirectory",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(() =>
      configError("target_directory_unavailable", "target_directory")
    ),
  );
  if (source.length === 0 || source.length > 512 * 1_024) {
    return yield* configError(
      "target_directory_unavailable",
      "target_directory",
    );
  }
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Array(A2aTargetDefinitionV1Schema).pipe(
        Schema.check(Schema.isMaxLength(256)),
      ),
    ),
    { onExcessProperty: "error" },
  )(source).pipe(
    Effect.mapError(() =>
      configError("target_directory_unavailable", "target_directory")
    ),
  );
});

const readDeploymentValue = Effect.fn("agentos.a2a.readDeploymentValue")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(() =>
        configError("deployment_unavailable", "deployment_file")
      ),
    );
    const value = source.trim();
    if (value === "" || value.length > 1_024) {
      return yield* configError("deployment_unavailable", "deployment_file");
    }
    return value;
  },
);

function validateRawConfig(raw: Config.Success<typeof RawConfig>) {
  const positive = [
    raw.gracefulShutdownMillis,
    raw.maximumBodyBytes,
    raw.requestTimeoutMillis,
    raw.databaseMaximumConnections,
    raw.databaseConnectTimeoutMillis,
    raw.kubernetesTimeoutMillis,
    raw.kubernetesMaximumResponseBytes,
    raw.openFgaTimeoutMillis,
    raw.openFgaMaximumResponseBytes,
  ];
  const kubernetesName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const valid = raw.port >= 1 && raw.port <= 65_535 &&
    raw.hostname.length > 0 && raw.hostname.length <= 253 &&
    raw.environment.length <= 63 &&
    (raw.environment === "" || kubernetesName.test(raw.environment)) &&
    positive.every((value) => Number.isSafeInteger(value) && value > 0) &&
    Number.isSafeInteger(raw.databaseMinimumConnections) &&
    raw.databaseMinimumConnections >= 0 &&
    raw.databaseMinimumConnections <= raw.databaseMaximumConnections &&
    raw.baseUrl.protocol === "https:" &&
    raw.kubernetesBaseUrl.protocol === "https:" &&
    ["http:", "https:"].includes(raw.openFgaBaseUrl.protocol) &&
    kubernetesName.test(raw.kubernetesNamespace) &&
    kubernetesName.test(raw.kubernetesServiceAccountName) &&
    raw.targetDirectoryFile.length > 0 &&
    raw.databaseUrlFile.length > 0 &&
    raw.kubernetesServiceAccountTokenPath.length > 0 &&
    raw.kubernetesServiceAccountCaPath.length > 0 &&
    raw.kubernetesReadinessTokenPath.length > 0 &&
    raw.openFgaDeploymentDirectory.length > 0;
  return valid
    ? Effect.void
    : configError("invalid_configuration", "limits");
}

function validateDatabaseUrl(databaseUrl: Redacted.Redacted<string>) {
  const value = Redacted.value(databaseUrl);
  if (!URL.canParse(value)) {
    return configError("invalid_configuration", "postgresql");
  }
  const url = new URL(value);
  return url.protocol === "postgres:" || url.protocol === "postgresql:"
    ? Effect.void
    : configError("invalid_configuration", "postgresql");
}

function configError(
  code: A2aEntrypointError["code"],
  field: A2aEntrypointError["field"],
) {
  return A2aEntrypointError.make({ code, field });
}

export function safeA2aEntrypointFailure(error: unknown) {
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
