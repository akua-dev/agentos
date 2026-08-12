import * as PgClient from "@effect/sql-pg/PgClient";
import {
  HermesProviderAuthorizer,
  KubernetesBoundServiceAccountAuthenticator,
  ProviderBudgetEnforcerPostgresLayer,
  ProviderBudgetSettlementCallerAuthenticator,
  ProviderDecisionReferenceGeneratorLiveLayer,
  makeKubernetesWorkloadIdentityLiveLayer,
} from "@akua-dev/agentos";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EgressAuthorizerReadiness } from "./app.ts";
import type { EgressAuthorizerConfig } from "./config.ts";

export interface EgressAuthorizerReadinessChecks {
  readonly postgresql: Effect.Effect<boolean, unknown>;
}

export function makeEgressAuthorizerReadinessLayer(
  checks: EgressAuthorizerReadinessChecks,
) {
  return Layer.succeed(EgressAuthorizerReadiness, {
    check: checks.postgresql,
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

  const hermesAuthorizer = HermesProviderAuthorizer.layer.pipe(
    Layer.provide(Layer.merge(
      boundServiceAccountAuthenticator,
      kubernetesIdentity,
    )),
  );
  const settlementCallerAuthenticator =
    ProviderBudgetSettlementCallerAuthenticator.layer.pipe(
      Layer.provide(boundServiceAccountAuthenticator),
  );

  const readiness = Layer.unwrap(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return makeEgressAuthorizerReadinessLayer({
      postgresql: sql<{ readonly ready: number }>`SELECT 1 AS ready`.pipe(
        Effect.flatMap(() =>
          sql<{ readonly ready: boolean }>`
            SELECT
              has_function_privilege(
                current_user,
                'agentos.reserve_workload_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint)',
                'EXECUTE'
              )
              AND has_function_privilege(
                current_user,
                'agentos.renew_workload_provider_attempt(text,text,text,bigint)',
                'EXECUTE'
              ) AS ready
          `
        ),
        Effect.map((rows) => rows.length === 1 && rows[0]?.ready === true),
      ),
    });
  })).pipe(
    Layer.provide(postgres),
  );

  return Layer.mergeAll(
    hermesAuthorizer,
    settlementCallerAuthenticator,
    providerBudgets,
    ProviderDecisionReferenceGeneratorLiveLayer,
    readiness,
  );
}
