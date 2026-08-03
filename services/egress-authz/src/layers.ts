import * as PgClient from "@effect/sql-pg/PgClient";
import {
  AGENTOS_OPENFGA_HEALTH_OBJECT,
  AGENTOS_OPENFGA_HEALTH_RELATION,
  AGENTOS_OPENFGA_HEALTH_USER,
  AgentOSWorkloadIdentityStorePostgresLayer,
  KubernetesBoundServiceAccountAuthenticator,
  OpenFgaAuthorizationApi,
  OpenFgaAuthorizationApiHttpLayer,
  ProviderAccessDatabaseSqlLayer,
  ProviderBudgetEnforcerPostgresLayer,
  ProviderBudgetSettlementCallerAuthenticator,
  ProviderDecisionReferenceGeneratorLiveLayer,
  ProviderPolicySnapshotStorePostgresLayer,
  WorkloadIdentityAuthenticator,
  makeKubernetesWorkloadIdentityLiveLayer,
  makeOpenFgaHttpTransportLayer,
  makeProviderPolicyDecisionPointLayer,
} from "@akua-dev/agentos";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EgressAuthorizerReadiness } from "./app.ts";
import type { EgressAuthorizerConfig } from "./config.ts";

export interface EgressAuthorizerReadinessChecks {
  readonly postgresql: Effect.Effect<boolean, unknown>;
  readonly openFga: Effect.Effect<boolean, unknown>;
}

export function makeEgressAuthorizerReadinessLayer(
  checks: EgressAuthorizerReadinessChecks,
) {
  return Layer.succeed(EgressAuthorizerReadiness, {
    check: Effect.all([
      checks.postgresql,
      checks.openFga,
    ], { concurrency: 2 }).pipe(
      Effect.map(([postgresql, openFga]) => postgresql && openFga),
    ),
  });
}

export function makeEgressAuthorizerLiveLayer(
  config: EgressAuthorizerConfig,
) {
  const postgres = PgClient.layer({
    url: config.databaseUrl,
    maxConnections: config.databaseMaximumConnections,
    minConnections: config.databaseMinimumConnections,
    connectTimeout: config.databaseConnectTimeoutMillis,
    idleTimeout: 30_000,
    applicationName: "agentos-egress-authz",
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
  const providerBudgets = ProviderBudgetEnforcerPostgresLayer.pipe(
    Layer.provide(postgres),
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
  const authenticator = WorkloadIdentityAuthenticator.layer.pipe(
    Layer.provide(Layer.merge(kubernetesIdentity, identityStore)),
  );
  const settlementCallerAuthenticator =
    ProviderBudgetSettlementCallerAuthenticator.layer.pipe(
      Layer.provide(boundServiceAccountAuthenticator),
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
  const decisionPoint = makeProviderPolicyDecisionPointLayer({
    deployment: config.openFgaDeployment,
    environment: config.environment,
  }).pipe(
    Layer.provide(Layer.mergeAll(
      policySnapshots,
      providerBudgets,
      openFgaAuthorization,
      ProviderDecisionReferenceGeneratorLiveLayer,
    )),
  );

  const readiness = Layer.unwrap(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const authorization = yield* OpenFgaAuthorizationApi;
    return makeEgressAuthorizerReadinessLayer({
      postgresql: sql<{ readonly ready: number }>`SELECT 1 AS ready`.pipe(
        Effect.flatMap(() =>
          sql<{ readonly ready: boolean }>`
            SELECT
              has_function_privilege(
                current_user,
                'agentos.read_egress_workload_agents(text,text)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.read_egress_assignments(uuid)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.read_egress_policy_snapshots(jsonb)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.reserve_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,bigint)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint)',
                'EXECUTE'
              ) AS ready
          `
        ),
        Effect.map((rows) => rows.length === 1 && rows[0]?.ready === true),
      ),
      openFga: authorization.check({
        ...config.openFgaDeployment,
        user: AGENTOS_OPENFGA_HEALTH_USER,
        relation: AGENTOS_OPENFGA_HEALTH_RELATION,
        object: AGENTOS_OPENFGA_HEALTH_OBJECT,
        context: {},
        consistency: "HIGHER_CONSISTENCY",
      }),
    });
  })).pipe(
    Layer.provide(Layer.merge(postgres, openFgaAuthorization)),
  );

  return Layer.mergeAll(
    authenticator,
    settlementCallerAuthenticator,
    providerBudgets,
    decisionPoint,
    ProviderDecisionReferenceGeneratorLiveLayer,
    readiness,
  );
}
