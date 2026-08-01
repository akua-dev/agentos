import { Crypto, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeProviderBudgetEnforcerLayer,
  providerBudgetKey,
  type ProviderBudgetProviderSettlementInputV1,
  type ProviderBudgetReservationInputV1,
  type ProviderBudgetSettlementInputV1,
  type ProviderBudgetStore,
} from "./provider-budget.ts";

type ProviderBudgetRow = Readonly<Record<string, unknown>>;

function normalizeReservation(
  input: ProviderBudgetReservationInputV1,
  budgetKey: string,
  row: ProviderBudgetRow | undefined,
): unknown {
  if (row?.outcome !== "reserved") {
    return {
      outcome: row?.outcome,
      effectiveRateClass: row?.effectiveRateClass,
      retryAtMillis: row?.retryAtMillis,
    };
  }
  return {
    schemaVersion: 1,
    decisionRef: input.decisionRef,
    budgetKey,
    outcome: row.outcome,
    effectiveRateClass: row.effectiveRateClass,
    requestWindowEndsAtMillis: row.requestWindowEndsAtMillis,
    tokenWindowEndsAtMillis: row.tokenWindowEndsAtMillis,
    spendWindowEndsAtMillis: row.spendWindowEndsAtMillis,
    leaseExpiresAtMillis: row.leaseExpiresAtMillis,
  };
}

function normalizeSettlement(
  input: Pick<ProviderBudgetSettlementInputV1, "decisionRef">,
  row: ProviderBudgetRow | undefined,
): unknown {
  return {
    schemaVersion: 1,
    decisionRef: input.decisionRef,
    outcome: row?.outcome,
    forwardOutcome: row?.forwardOutcome,
    inputTokens: row?.inputTokens,
    outputTokens: row?.outputTokens,
    cachedInputTokens: row?.cachedInputTokens,
    spendMicros: row?.spendMicros,
    settledAtMillis: row?.settledAtMillis,
  };
}

export const ProviderBudgetEnforcerPostgresLayer = Layer.unwrap(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const reserve = Effect.fn("ProviderBudgetStorePostgres.reserve")(
      function*(input: ProviderBudgetReservationInputV1) {
        const budgetKey = yield* providerBudgetKey(input).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
        const rows = yield* sql<ProviderBudgetRow>`
          SELECT * FROM agentos.reserve_provider_budget(
            ${input.decisionRef},
            ${budgetKey},
            ${input.bindingId},
            ${JSON.stringify(input.subject)}::jsonb,
            ${input.provider},
            ${input.credentialDomain},
            ${input.capability},
            ${JSON.stringify(input.resource)}::jsonb,
            ${input.environment},
            ${input.rateClass},
            ${input.correlationId},
            ${input.nowMillis}
          )
        `;
        return normalizeReservation(input, budgetKey, rows[0]);
      },
    );
    const settle = Effect.fn("ProviderBudgetStorePostgres.settle")(
      function*(input: ProviderBudgetSettlementInputV1) {
        const rows = yield* sql<ProviderBudgetRow>`
          SELECT * FROM agentos.settle_provider_budget(
            ${input.decisionRef},
            ${JSON.stringify(input.subject)}::jsonb,
            ${input.forwardOutcome},
            ${input.inputTokens},
            ${input.outputTokens},
            ${input.cachedInputTokens},
            ${input.spendMicros},
            ${input.settledAtMillis}
          )
        `;
        return normalizeSettlement(input, rows[0]);
      },
    );
    const settleProvider = Effect.fn(
      "ProviderBudgetStorePostgres.settleProvider",
    )(function*(input: ProviderBudgetProviderSettlementInputV1) {
      const rows = yield* sql<ProviderBudgetRow>`
        SELECT * FROM agentos.settle_provider_budget_for_provider(
          ${input.decisionRef},
          ${input.provider},
          ${input.credentialDomain},
          ${input.forwardOutcome},
          ${input.inputTokens},
          ${input.outputTokens},
          ${input.cachedInputTokens},
          ${input.spendMicros},
          ${input.settledAtMillis}
        )
      `;
      return normalizeSettlement(input, rows[0]);
    });
    const store: ProviderBudgetStore = {
      reserve,
      settle,
      settleProvider,
    };
    return makeProviderBudgetEnforcerLayer(store);
  }),
);
