import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";

import type {
  AccessBindingSubjectV1,
  AuthorizationResourceV1,
} from "../contracts.ts";
import {
  ProviderBudgetEnforcementError,
  ProviderBudgetEnforcer,
  ProviderBudgetReservationV1Schema,
  ProviderBudgetSettlementV1Schema,
  makeProviderBudgetEnforcerLayer,
  providerBudgetKey,
  providerBudgetRateClassesV1,
  type ProviderBudgetRateClassV1,
  type ProviderBudgetProviderSettlementInputV1,
  type ProviderBudgetReservationInputV1,
  type ProviderBudgetStore,
} from "../provider-budget.ts";

const now = Date.parse("2026-08-01T12:00:00.000Z");
const subject: AccessBindingSubjectV1 = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: "11111111-1111-4111-8111-111111111111",
};
const assignment: AccessBindingSubjectV1 = {
  kind: "assignment",
  fleet: "agentos",
  domain: "platform",
  assignmentId: "22222222-2222-4222-8222-222222222222",
};
const resource: AuthorizationResourceV1 = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};
const reservationInput: ProviderBudgetReservationInputV1 = {
  schemaVersion: 1,
  decisionRef: "decision_11111111111111111111111111111111",
  correlationId: "corr_22222222222222222222222222222222",
  bindingId: "binding_33333333333333333333333333333333",
  subject,
  provider: "github",
  credentialDomain: "github",
  capability: "github.issue.write",
  resource,
  environment: "production",
  rateClass: "standard",
  nowMillis: now,
};

describe("provider budget enforcement", () => {
  it.effect("publishes monotonic reusable request, concurrency, token, and spend classes", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        providerBudgetRateClassesV1.map(({ rateClass }) => rateClass),
        ["disabled", "low", "standard", "high"],
      );
      const [disabled, low, standard, high] = providerBudgetRateClassesV1;
      assert.deepStrictEqual({
        requests: disabled?.maximumRequests,
        concurrent: disabled?.maximumConcurrent,
        tokens: disabled?.maximumTokens,
        spend: disabled?.maximumSpendMicros,
      }, { requests: 0, concurrent: 0, tokens: 0, spend: 0 });
      const monotonicFields: ReadonlyArray<keyof Pick<
        ProviderBudgetRateClassV1,
        | "maximumRequests"
        | "maximumConcurrent"
        | "maximumTokens"
        | "maximumSpendMicros"
      >> = [
        "maximumRequests",
        "maximumConcurrent",
        "maximumTokens",
        "maximumSpendMicros",
      ];
      for (const field of monotonicFields) {
        assert.isBelow(low?.[field] ?? 0, standard?.[field] ?? 0);
        assert.isBelow(standard?.[field] ?? 0, high?.[field] ?? 0);
      }
      assert.strictEqual(low?.requestWindowMillis, 60_000);
      assert.strictEqual(low?.tokenWindowMillis, 60_000);
      assert.strictEqual(low?.spendWindowMillis, 3_600_000);
    }));

  it.effect("derives stable route keys from durable Mate or Assignment identity", () =>
    Effect.gen(function*() {
      const first = yield* providerBudgetKey(reservationInput);
      const retry = yield* providerBudgetKey({ ...reservationInput });
      const otherDecision = yield* providerBudgetKey({
        ...reservationInput,
        decisionRef: "decision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        correlationId: "corr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      const assignmentKey = yield* providerBudgetKey({
        ...reservationInput,
        subject: assignment,
      });
      assert.strictEqual(first, retry);
      assert.strictEqual(first, otherDecision);
      assert.notStrictEqual(first, assignmentKey);
      assert.match(first, /^budget_[0-9a-f]{64}$/);
      assert.notInclude(first, subject.agentId);
      assert.notInclude(first, resource.repository);
    }).pipe(Effect.provide(BunCryptoLayer)));

  it.effect("decodes closed reservation and settlement results", () =>
    Effect.gen(function*() {
      const reserved = yield* Schema.decodeUnknownEffect(
        ProviderBudgetReservationV1Schema,
        { onExcessProperty: "error" },
      )({
        schemaVersion: 1,
        decisionRef: reservationInput.decisionRef,
        budgetKey: `budget_${"a".repeat(64)}`,
        outcome: "reserved",
        effectiveRateClass: "standard",
        requestWindowEndsAtMillis: now + 60_000,
        tokenWindowEndsAtMillis: now + 60_000,
        spendWindowEndsAtMillis: now + 3_600_000,
        leaseExpiresAtMillis: now + 900_000,
      });
      assert.strictEqual(reserved.outcome, "reserved");
      const settled = yield* Schema.decodeUnknownEffect(
        ProviderBudgetSettlementV1Schema,
        { onExcessProperty: "error" },
      )({
        schemaVersion: 1,
        decisionRef: reservationInput.decisionRef,
        outcome: "settled",
        forwardOutcome: "completed",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 50,
        spendMicros: 1_250,
        settledAtMillis: now + 1_000,
      });
      assert.strictEqual(settled.cachedInputTokens, 50);
      const invalid = yield* Effect.exit(Schema.decodeUnknownEffect(
        ProviderBudgetSettlementV1Schema,
        { onExcessProperty: "error" },
      )({ ...settled, providerBody: "forbidden" }));
      assert.isTrue(invalid._tag === "Failure");
    }));

  it.effect("maps durable reserve outcomes without exposing store failures", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0);
      const store: ProviderBudgetStore = {
        reserve: (input) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed({
              outcome: "rate_limited",
              effectiveRateClass: "low",
              retryAtMillis: input.nowMillis + 60_000,
            })),
          ),
        settle: () => Effect.die("settlement not expected"),
        settleProvider: () => Effect.die("provider settlement not expected"),
      };
      const enforcer = yield* ProviderBudgetEnforcer.pipe(
        Effect.provide(makeProviderBudgetEnforcerLayer(store)),
      );
      const failure = yield* enforcer.reserve(reservationInput).pipe(
        Effect.flip,
      );
      assert.instanceOf(failure, ProviderBudgetEnforcementError);
      assert.deepStrictEqual(
        [failure.outcome, failure.retryable, failure.retryAtMillis],
        ["rate_limited", true, now + 60_000],
      );
      assert.deepStrictEqual(Object.keys(failure).sort(), [
        "_tag",
        "outcome",
        "retryAtMillis",
        "retryable",
      ]);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }));

  it.effect("rejects impossible settlement usage before touching durable state", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0);
      const store: ProviderBudgetStore = {
        reserve: () => Effect.die("reservation not expected"),
        settle: () => Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("invalid input reached store")),
        ),
        settleProvider: () => Effect.die("provider settlement not expected"),
      };
      const enforcer = yield* ProviderBudgetEnforcer.pipe(
        Effect.provide(makeProviderBudgetEnforcerLayer(store)),
      );
      const failure = yield* enforcer.settle({
        schemaVersion: 1,
        decisionRef: reservationInput.decisionRef,
        subject,
        forwardOutcome: "completed",
        inputTokens: 10,
        outputTokens: 0,
        cachedInputTokens: 11,
        spendMicros: 0,
        settledAtMillis: now + 1_000,
      }).pipe(Effect.flip);
      assert.strictEqual(failure.outcome, "invalid_settlement");
      assert.strictEqual(failure.retryable, false);
      assert.strictEqual(yield* Ref.get(calls), 0);
    }));

  it.effect("settles through provider-derived authority without accepting a subject", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<
        ReadonlyArray<ProviderBudgetProviderSettlementInputV1>
      >([]);
      const store: ProviderBudgetStore = {
        reserve: () => Effect.die("reservation not expected"),
        settle: () => Effect.die("subject settlement not expected"),
        settleProvider: (input) =>
          Ref.update(seen, (current) => [...current, input]).pipe(
            Effect.as({
              schemaVersion: 1,
              decisionRef: input.decisionRef,
              outcome: "settled",
              forwardOutcome: input.forwardOutcome,
              inputTokens: input.inputTokens,
              outputTokens: input.outputTokens,
              cachedInputTokens: input.cachedInputTokens,
              spendMicros: input.spendMicros,
              settledAtMillis: input.settledAtMillis,
            }),
          ),
      };
      const settlement: ProviderBudgetProviderSettlementInputV1 = {
        schemaVersion: 1,
        decisionRef: reservationInput.decisionRef,
        provider: "github",
        credentialDomain: "github",
        forwardOutcome: "provider_rejected",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        spendMicros: 0,
        settledAtMillis: now + 1_000,
      };
      const result = yield* ProviderBudgetEnforcer.pipe(
        Effect.flatMap((budgets) => budgets.settleProvider(settlement)),
        Effect.provide(makeProviderBudgetEnforcerLayer(store)),
      );
      assert.deepStrictEqual(result, {
        schemaVersion: 1,
        decisionRef: settlement.decisionRef,
        outcome: "settled",
        forwardOutcome: "provider_rejected",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        spendMicros: 0,
        settledAtMillis: now + 1_000,
      });
      assert.deepStrictEqual(yield* Ref.get(seen), [settlement]);
    }));
});
