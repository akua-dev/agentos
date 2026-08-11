import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";

import {
  ProviderBudgetEnforcer,
  type ProviderBudgetProviderSettlementInputV1,
  type ProviderBudgetReservationInputV1,
  type ProviderBudgetSettlementInputV1,
  type ProviderBudgetWorkloadReservationInputV1,
} from "../provider-budget.ts";
import { ProviderBudgetEnforcerPostgresLayer } from "../provider-budget-postgres.ts";

const now = 1_785_585_600_000;
const workloadInput = {
  schemaVersion: 1,
  decisionRef: `decision_${"a".repeat(32)}`,
  correlationId: `corr_${"b".repeat(32)}`,
  principal: {
    kind: "kubernetes_workload",
    namespace: "agentos",
    serviceAccountName: "hermes",
    serviceAccountUid: "11111111-1111-4111-8111-111111111111",
    podName: "hermes-0",
    podUid: "22222222-2222-4222-8222-222222222222",
    policyRevision: 7,
    policyResourceVersion: "18422",
    hermesProfile: "fleet-codex",
  },
  provider: "openai",
  credentialDomain: "openai-responses",
  capability: "openai.responses.create",
  resource: {
    kind: "provider_service",
    provider: "openai",
    service: "responses",
  },
  environment: "production",
  model: "gpt-5.6-sol",
  rateClass: "low",
  limits: {
    requestWindowMillis: 60_000,
    maximumRequests: 12,
    maximumConcurrent: 2,
    tokenWindowMillis: 60_000,
    maximumTokens: 100_000,
    spendWindowMillis: 3_600_000,
    maximumSpendMicros: 1_000_000,
  },
  policyExpiresAtMillis: now + 60_000,
  nowMillis: now,
} satisfies ProviderBudgetWorkloadReservationInputV1;
const input: ProviderBudgetReservationInputV1 = {
  schemaVersion: 1,
  decisionRef: `decision_${"1".repeat(32)}`,
  correlationId: `corr_${"2".repeat(32)}`,
  bindingId: `binding_${"3".repeat(32)}`,
  subject: {
    kind: "mate",
    fleet: "agentos",
    domain: "platform",
    agentId: "51000000-0000-4000-8000-000000000003",
  },
  provider: "github",
  credentialDomain: "github",
  capability: "github.issue.write",
  resource: {
    kind: "github_repository",
    owner: "akua-dev",
    repository: "agentos",
  },
  environment: "production",
  rateClass: "low",
  nowMillis: now,
};

function sqlClientLayer(
  execute: (
    statement: string,
    parameters: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) {
  const connection: SqlConnection.Connection = {
    execute: (statement, parameters, transformRows) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) =>
          transformRows === undefined ? rows : transformRows(rows)
        ),
      ),
    executeRaw: execute,
    executeStream: (statement, parameters, transformRows) =>
      Stream.fromEffect(execute(statement, parameters)).pipe(
        Stream.flatMap((rows) =>
          Stream.fromIterable(
            transformRows === undefined ? rows : transformRows(rows),
          )
        ),
      ),
    executeValues: (statement, parameters) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) => rows.map((row) => Object.values(row))),
      ),
    executeValuesUnprepared: (statement, parameters) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) => rows.map((row) => Object.values(row))),
      ),
    executeUnprepared: (statement, parameters, transformRows) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) =>
          transformRows === undefined ? rows : transformRows(rows)
        ),
      ),
  };
  return Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer));
}

function liveLayer(
  execute: Parameters<typeof sqlClientLayer>[0],
) {
  return ProviderBudgetEnforcerPostgresLayer.pipe(
    Layer.provide(Layer.merge(sqlClientLayer(execute), BunCryptoLayer)),
  );
}

describe("PostgreSQL provider budget enforcer", () => {
  it.effect("uses the workload reservation function without a legacy binding", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly statement: string; readonly parameters: ReadonlyArray<unknown> }> = [];
      const layer = liveLayer((statement, parameters) => {
        calls.push({ statement, parameters });
        return Effect.succeed([{
          outcome: "reserved",
          effectiveRateClass: "low",
          retryAtMillis: null,
          requestWindowEndsAtMillis: now + 60_000,
          tokenWindowEndsAtMillis: now + 60_000,
          spendWindowEndsAtMillis: now + 3_600_000,
          leaseExpiresAtMillis: now + 15_000,
        }]);
      });
      yield* ProviderBudgetEnforcer.pipe(
        Effect.flatMap((budgets) => budgets.reserveWorkload(workloadInput)),
        Effect.provide(layer),
      );
      assert.match(calls[0]!.statement, /reserve_workload_provider_budget/);
      assert.notInclude(calls[0]!.statement, "access_bindings");
      assert.notInclude(calls[0]!.parameters, "binding_");
    }));

  it.effect("reserves one stable subject/route budget through the narrow function", () =>
    Effect.gen(function*() {
      const calls: Array<{
        readonly statement: string;
        readonly parameters: ReadonlyArray<unknown>;
      }> = [];
      const layer = liveLayer((statement, parameters) => {
        calls.push({ statement, parameters });
        return Effect.succeed([{
          outcome: "reserved",
          effectiveRateClass: "low",
          retryAtMillis: null,
          requestWindowEndsAtMillis: now + 60_000,
          tokenWindowEndsAtMillis: now + 60_000,
          spendWindowEndsAtMillis: now + 3_600_000,
          leaseExpiresAtMillis: now + 900_000,
        }]);
      });
      const result = yield* ProviderBudgetEnforcer.pipe(
        Effect.flatMap((budgets) => budgets.reserve(input)),
        Effect.provide(layer),
      );
      assert.match(result.budgetKey, /^budget_[0-9a-f]{64}$/);
      assert.deepStrictEqual(result, {
        schemaVersion: 1,
        decisionRef: input.decisionRef,
        budgetKey: result.budgetKey,
        outcome: "reserved",
        effectiveRateClass: "low",
        requestWindowEndsAtMillis: now + 60_000,
        tokenWindowEndsAtMillis: now + 60_000,
        spendWindowEndsAtMillis: now + 3_600_000,
        leaseExpiresAtMillis: now + 900_000,
      });
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0]!.statement, /reserve_provider_budget/);
      assert.strictEqual(calls[0]!.parameters[0], input.decisionRef);
      assert.strictEqual(calls[0]!.parameters[1], result.budgetKey);
      assert.strictEqual(calls[0]!.parameters.at(-1), now);
    }));

  it.effect("keeps rate and spend exhaustion distinct", () =>
    Effect.gen(function*() {
      const outcomes: ReadonlyArray<"rate_limited" | "budget_exhausted"> = [
        "rate_limited",
        "budget_exhausted",
      ];
      for (const outcome of outcomes) {
        const layer = liveLayer(() => Effect.succeed([{
          outcome,
          effectiveRateClass: "low",
          retryAtMillis: now + 60_000,
          requestWindowEndsAtMillis: now + 60_000,
          tokenWindowEndsAtMillis: now + 60_000,
          spendWindowEndsAtMillis: now + 3_600_000,
          leaseExpiresAtMillis: null,
        }]));
        const failure = yield* ProviderBudgetEnforcer.pipe(
          Effect.flatMap((budgets) => budgets.reserve(input)),
          Effect.provide(layer),
          Effect.flip,
        );
        assert.strictEqual(failure.outcome, outcome);
        assert.strictEqual(failure.retryAtMillis, now + 60_000);
      }
    }));

  it.effect("settles exact provider usage and rejects malformed database rows", () =>
    Effect.gen(function*() {
      const settlement: ProviderBudgetSettlementInputV1 = {
        schemaVersion: 1,
        decisionRef: input.decisionRef,
        subject: input.subject,
        forwardOutcome: "completed",
        inputTokens: 800,
        outputTokens: 200,
        cachedInputTokens: 100,
        spendMicros: 50_000,
        settledAtMillis: now + 1_000,
      };
      const valid = liveLayer((statement) => {
        assert.match(statement, /settle_provider_budget/);
        return Effect.succeed([{
          outcome: "settled",
          forwardOutcome: "completed",
          inputTokens: 800,
          outputTokens: 200,
          cachedInputTokens: 100,
          spendMicros: 50_000,
          settledAtMillis: now + 1_000,
        }]);
      });
      assert.deepStrictEqual(
        yield* ProviderBudgetEnforcer.pipe(
          Effect.flatMap((budgets) => budgets.settle(settlement)),
          Effect.provide(valid),
        ),
        {
          schemaVersion: 1,
          decisionRef: input.decisionRef,
          outcome: "settled",
          forwardOutcome: "completed",
          inputTokens: 800,
          outputTokens: 200,
          cachedInputTokens: 100,
          spendMicros: 50_000,
          settledAtMillis: now + 1_000,
        },
      );

      const malformed = liveLayer(() => Effect.succeed([{
        outcome: "reserved",
        effectiveRateClass: "root",
      }]));
      const failure = yield* ProviderBudgetEnforcer.pipe(
        Effect.flatMap((budgets) => budgets.reserve(input)),
        Effect.provide(malformed),
        Effect.flip,
      );
      assert.strictEqual(failure.outcome, "policy_stale");
    }));

  it.effect("settles through the provider-scoped security-definer function", () =>
    Effect.gen(function*() {
      const calls: Array<{
        readonly statement: string;
        readonly parameters: ReadonlyArray<unknown>;
      }> = [];
      const settlement: ProviderBudgetProviderSettlementInputV1 = {
        schemaVersion: 1,
        decisionRef: input.decisionRef,
        provider: "github",
        credentialDomain: "github",
        forwardOutcome: "completed",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        spendMicros: 0,
        settledAtMillis: now + 2_000,
      };
      const layer = liveLayer((statement, parameters) => {
        calls.push({ statement, parameters });
        return Effect.succeed([{
          outcome: "settled",
          forwardOutcome: settlement.forwardOutcome,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          spendMicros: 0,
          settledAtMillis: settlement.settledAtMillis,
        }]);
      });
      const result = yield* ProviderBudgetEnforcer.pipe(
        Effect.flatMap((budgets) => budgets.settleProvider(settlement)),
        Effect.provide(layer),
      );
      assert.strictEqual(result.outcome, "settled");
      assert.match(calls[0]!.statement, /settle_provider_budget_for_provider/);
      assert.deepStrictEqual(calls[0]!.parameters.slice(0, 3), [
        input.decisionRef,
        "github",
        "github",
      ]);
    }));
});
