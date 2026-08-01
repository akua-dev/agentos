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
  type ProviderBudgetReservationInputV1,
  type ProviderBudgetSettlementInputV1,
} from "../provider-budget.ts";
import { ProviderBudgetEnforcerPostgresLayer } from "../provider-budget-postgres.ts";

const now = 1_785_585_600_000;
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
});
