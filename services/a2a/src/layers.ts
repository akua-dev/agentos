import * as PgClient from "@effect/sql-pg/PgClient";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  A2aCanonicalDatabaseSqlLayer,
  A2aCanonicalDeliveryStorePostgresLayer,
  AgentOSWorkloadIdentityStorePostgresLayer,
  KubernetesBoundServiceAccountAuthenticator,
  OpenFgaAuthorizationApiHttpLayer,
  ProviderAccessDatabaseSqlLayer,
  ProviderPolicySnapshotStorePostgresLayer,
  WorkloadIdentityAuthenticator,
  makeA2aPolicyAuthorizerLayer,
  makeKubernetesWorkloadIdentityLiveLayer,
  makeOpenFgaHttpTransportLayer,
} from "@akua-dev/agentos";
import { Effect, FileSystem, Layer } from "effect";

import { A2aServiceReadiness } from "./app.ts";
import type { A2aServiceConfig } from "./config.ts";
import { A2aTransportTelemetryLiveLayer } from "./telemetry.ts";

export function makeA2aIdentityReadinessLayer(options: {
  readonly audience: string;
  readonly tokenFile: string;
  readonly namespace: string;
  readonly serviceAccountName: string;
}) {
  return Layer.effect(A2aServiceReadiness, Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const authenticator = yield* KubernetesBoundServiceAccountAuthenticator;
    return A2aServiceReadiness.of({
      check: fileSystem.readFileString(options.tokenFile).pipe(
        Effect.flatMap((bearerToken) =>
          authenticator.authenticate({
            bearerToken,
            audience: options.audience,
          })
        ),
        Effect.map((identity) =>
          identity.kubernetesNamespace === options.namespace &&
          identity.serviceAccountName === options.serviceAccountName
        ),
      ),
    });
  }));
}

export function makeA2aServiceLiveLayer(config: A2aServiceConfig) {
  const postgres = PgClient.layer({
    url: config.databaseUrl,
    maxConnections: config.databaseMaximumConnections,
    minConnections: config.databaseMinimumConnections,
    connectTimeout: config.databaseConnectTimeoutMillis,
    idleTimeout: 30_000,
    applicationName: "agentos-a2a",
  });
  const accessDatabase = ProviderAccessDatabaseSqlLayer.pipe(
    Layer.provide(postgres),
  );
  const identityStore = AgentOSWorkloadIdentityStorePostgresLayer.pipe(
    Layer.provide(accessDatabase),
  );
  const policySnapshots = ProviderPolicySnapshotStorePostgresLayer.pipe(
    Layer.provide(accessDatabase),
  );
  const canonicalDatabase = A2aCanonicalDatabaseSqlLayer.pipe(
    Layer.provide(postgres),
  );
  const canonicalStore = A2aCanonicalDeliveryStorePostgresLayer.pipe(
    Layer.provide(canonicalDatabase),
  );

  const kubernetesIdentity = makeKubernetesWorkloadIdentityLiveLayer({
    baseUrl: config.kubernetesBaseUrl,
    serviceAccountTokenPath: config.kubernetesServiceAccountTokenPath,
    serviceAccountCaPath: config.kubernetesServiceAccountCaPath,
    timeoutMillis: config.kubernetesTimeoutMillis,
    maximumResponseBytes: config.kubernetesMaximumResponseBytes,
  });
  const boundServiceAccountAuthenticator =
    KubernetesBoundServiceAccountAuthenticator.layer.pipe(
      Layer.provide(kubernetesIdentity),
    );
  const workloadAuthenticator = WorkloadIdentityAuthenticator.layer.pipe(
    Layer.provide(Layer.merge(kubernetesIdentity, identityStore)),
  );

  const openFgaTransport = makeOpenFgaHttpTransportLayer({
    baseUrl: config.openFgaBaseUrl,
    presharedKey: config.openFgaPresharedKey,
    timeoutMillis: config.openFgaTimeoutMillis,
    maximumResponseBytes: config.openFgaMaximumResponseBytes,
  });
  const openFgaAuthorization = OpenFgaAuthorizationApiHttpLayer.pipe(
    Layer.provide(openFgaTransport),
  );
  const policy = makeA2aPolicyAuthorizerLayer({
    deployment: config.openFgaDeployment,
    environment: config.environment,
  }).pipe(
    Layer.provide(Layer.merge(policySnapshots, openFgaAuthorization)),
  );
  const readiness = makeA2aIdentityReadinessLayer({
    audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
    tokenFile: config.kubernetesReadinessTokenPath,
    namespace: config.kubernetesNamespace,
    serviceAccountName: config.kubernetesServiceAccountName,
  }).pipe(Layer.provide(boundServiceAccountAuthenticator));

  return Layer.mergeAll(
    workloadAuthenticator,
    canonicalStore,
    policy,
    readiness,
    A2aTransportTelemetryLiveLayer,
  );
}
