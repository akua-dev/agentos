import {
  Context,
  Crypto,
  Effect,
  Encoding,
  Layer,
  Schema,
} from "effect";

import {
  AccessBindingSubjectV1Schema,
  AccessCapabilityIdSchema,
  AccessProviderIdSchema,
  AccessRateClassIdSchema,
  AuthorizationResourceV1Schema,
  authorizationResourceName,
  authorizationSubjectName,
} from "./contracts.ts";

const SafeNonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const SafePositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const EpochMillis = SafeNonNegativeInteger;
const DecisionRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^decision_[0-9a-f]{32}$/)),
);
const CorrelationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^corr_[0-9a-f]{32}$/)),
);
const BudgetKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^budget_[0-9a-f]{64}$/)),
);
const BindingId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^binding_[0-9a-f]{32}$/)),
);
const CredentialDomain = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const Environment = Schema.NullOr(Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
));

export const ProviderBudgetRateClassV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rateClass: AccessRateClassIdSchema,
  requestWindowMillis: SafePositiveInteger,
  tokenWindowMillis: SafePositiveInteger,
  spendWindowMillis: SafePositiveInteger,
  maximumRequests: SafeNonNegativeInteger,
  maximumConcurrent: SafeNonNegativeInteger,
  maximumTokens: SafeNonNegativeInteger,
  maximumSpendMicros: SafeNonNegativeInteger,
  reservationTtlMillis: SafePositiveInteger,
});

export type ProviderBudgetRateClassV1 =
  typeof ProviderBudgetRateClassV1Schema.Type;

export const providerBudgetRateClassesV1: readonly [
  ProviderBudgetRateClassV1,
  ProviderBudgetRateClassV1,
  ProviderBudgetRateClassV1,
  ProviderBudgetRateClassV1,
] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    rateClass: "disabled",
    requestWindowMillis: 60_000,
    tokenWindowMillis: 60_000,
    spendWindowMillis: 3_600_000,
    maximumRequests: 0,
    maximumConcurrent: 0,
    maximumTokens: 0,
    maximumSpendMicros: 0,
    reservationTtlMillis: 900_000,
  }),
  Object.freeze({
    schemaVersion: 1,
    rateClass: "low",
    requestWindowMillis: 60_000,
    tokenWindowMillis: 60_000,
    spendWindowMillis: 3_600_000,
    maximumRequests: 12,
    maximumConcurrent: 2,
    maximumTokens: 100_000,
    maximumSpendMicros: 1_000_000,
    reservationTtlMillis: 900_000,
  }),
  Object.freeze({
    schemaVersion: 1,
    rateClass: "standard",
    requestWindowMillis: 60_000,
    tokenWindowMillis: 60_000,
    spendWindowMillis: 3_600_000,
    maximumRequests: 60,
    maximumConcurrent: 8,
    maximumTokens: 1_000_000,
    maximumSpendMicros: 10_000_000,
    reservationTtlMillis: 900_000,
  }),
  Object.freeze({
    schemaVersion: 1,
    rateClass: "high",
    requestWindowMillis: 60_000,
    tokenWindowMillis: 60_000,
    spendWindowMillis: 3_600_000,
    maximumRequests: 300,
    maximumConcurrent: 32,
    maximumTokens: 10_000_000,
    maximumSpendMicros: 100_000_000,
    reservationTtlMillis: 900_000,
  }),
]);

export const ProviderBudgetReservationInputV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decisionRef: DecisionRef,
  correlationId: CorrelationId,
  bindingId: BindingId,
  subject: AccessBindingSubjectV1Schema,
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  environment: Environment,
  rateClass: AccessRateClassIdSchema,
  nowMillis: EpochMillis,
});

export const ProviderBudgetReservationV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decisionRef: DecisionRef,
  budgetKey: BudgetKey,
  outcome: Schema.Literal("reserved"),
  effectiveRateClass: AccessRateClassIdSchema,
  requestWindowEndsAtMillis: EpochMillis,
  tokenWindowEndsAtMillis: EpochMillis,
  spendWindowEndsAtMillis: EpochMillis,
  leaseExpiresAtMillis: EpochMillis,
});

const ProviderBudgetForwardOutcome = Schema.Literals([
  "completed",
  "cancelled",
  "provider_rejected",
  "transport_failed",
]);

const ProviderBudgetSettlementReportV1Fields = {
  schemaVersion: Schema.Literal(1),
  decisionRef: DecisionRef,
  forwardOutcome: ProviderBudgetForwardOutcome,
  inputTokens: SafeNonNegativeInteger,
  outputTokens: SafeNonNegativeInteger,
  cachedInputTokens: SafeNonNegativeInteger,
  spendMicros: SafeNonNegativeInteger,
};

const settlementUsageCheck = Schema.makeFilter(
  (input: { readonly cachedInputTokens: number; readonly inputTokens: number }) =>
    input.cachedInputTokens <= input.inputTokens,
  { title: "cached input tokens cannot exceed input tokens" },
);

export const ProviderBudgetSettlementReportV1Schema = Schema.Struct(
  ProviderBudgetSettlementReportV1Fields,
).pipe(
  Schema.check(settlementUsageCheck),
);

export const ProviderBudgetSettlementInputV1Schema = Schema.Struct({
  ...ProviderBudgetSettlementReportV1Fields,
  subject: AccessBindingSubjectV1Schema,
  settledAtMillis: EpochMillis,
}).pipe(
  Schema.check(Schema.makeFilter(
    (input) => input.cachedInputTokens <= input.inputTokens,
    { title: "cached input tokens cannot exceed input tokens" },
  )),
);

export const ProviderBudgetProviderSettlementInputV1Schema = Schema.Struct({
  ...ProviderBudgetSettlementReportV1Fields,
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  settledAtMillis: EpochMillis,
}).pipe(
  Schema.check(Schema.makeFilter(
    (input) => input.cachedInputTokens <= input.inputTokens,
    { title: "cached input tokens cannot exceed input tokens" },
  )),
);

export const ProviderBudgetSettlementV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decisionRef: DecisionRef,
  outcome: Schema.Literal("settled"),
  forwardOutcome: ProviderBudgetForwardOutcome,
  inputTokens: SafeNonNegativeInteger,
  outputTokens: SafeNonNegativeInteger,
  cachedInputTokens: SafeNonNegativeInteger,
  spendMicros: SafeNonNegativeInteger,
  settledAtMillis: EpochMillis,
});

export type ProviderBudgetReservationInputV1 =
  typeof ProviderBudgetReservationInputV1Schema.Type;
export type ProviderBudgetReservationV1 =
  typeof ProviderBudgetReservationV1Schema.Type;
export type ProviderBudgetSettlementInputV1 =
  typeof ProviderBudgetSettlementInputV1Schema.Type;
export type ProviderBudgetSettlementReportV1 =
  typeof ProviderBudgetSettlementReportV1Schema.Type;
export type ProviderBudgetProviderSettlementInputV1 =
  typeof ProviderBudgetProviderSettlementInputV1Schema.Type;
export type ProviderBudgetSettlementV1 =
  typeof ProviderBudgetSettlementV1Schema.Type;

const ProviderBudgetStoreReservationResultSchema = Schema.Union([
  ProviderBudgetReservationV1Schema,
  Schema.Struct({
    outcome: Schema.Literals([
      "rate_class_disabled",
      "rate_limited",
      "budget_exhausted",
    ]),
    effectiveRateClass: AccessRateClassIdSchema,
    retryAtMillis: Schema.NullOr(EpochMillis),
  }),
]);

export type ProviderBudgetStoreReservationResult =
  typeof ProviderBudgetStoreReservationResultSchema.Type;

export interface ProviderBudgetStore {
  readonly reserve: (
    input: ProviderBudgetReservationInputV1,
  ) => Effect.Effect<unknown, unknown>;
  readonly settle: (
    input: ProviderBudgetSettlementInputV1,
  ) => Effect.Effect<unknown, unknown>;
  readonly settleProvider: (
    input: ProviderBudgetProviderSettlementInputV1,
  ) => Effect.Effect<unknown, unknown>;
}

const ProviderBudgetEnforcementOutcome = Schema.Literals([
  "invalid_reservation",
  "invalid_settlement",
  "database_unavailable",
  "policy_stale",
  "rate_class_disabled",
  "rate_limited",
  "budget_exhausted",
]);

export class ProviderBudgetEnforcementError extends Schema.TaggedErrorClass<ProviderBudgetEnforcementError>()(
  "ProviderBudgetEnforcementError",
  {
    outcome: ProviderBudgetEnforcementOutcome,
    retryable: Schema.Boolean,
    retryAtMillis: Schema.NullOr(EpochMillis),
  },
) {}

export class ProviderBudgetEnforcer extends Context.Service<
  ProviderBudgetEnforcer,
  {
    readonly reserve: (
      input: ProviderBudgetReservationInputV1,
    ) => Effect.Effect<
      ProviderBudgetReservationV1,
      ProviderBudgetEnforcementError
    >;
    readonly settle: (
      input: ProviderBudgetSettlementInputV1,
    ) => Effect.Effect<
      ProviderBudgetSettlementV1,
      ProviderBudgetEnforcementError
    >;
    readonly settleProvider: (
      input: ProviderBudgetProviderSettlementInputV1,
    ) => Effect.Effect<
      ProviderBudgetSettlementV1,
      ProviderBudgetEnforcementError
    >;
  }
>()("agentos/access/ProviderBudgetEnforcer") {}

function enforcementError(
  outcome: ProviderBudgetEnforcementError["outcome"],
  retryable: boolean,
  retryAtMillis: number | null = null,
) {
  return ProviderBudgetEnforcementError.make({
    outcome,
    retryable,
    retryAtMillis,
  });
}

export function makeProviderBudgetEnforcerLayer(store: ProviderBudgetStore) {
  const reserve = Effect.fn("agentos.providerBudget.reserve")(function*(
    untrusted: unknown,
  ) {
    const input = yield* Schema.decodeUnknownEffect(
      ProviderBudgetReservationInputV1Schema,
      { onExcessProperty: "error" },
    )(untrusted).pipe(
      Effect.mapError(() => enforcementError("invalid_reservation", false)),
    );
    const raw = yield* store.reserve(input).pipe(
      Effect.mapError(() => enforcementError("database_unavailable", true)),
    );
    const result = yield* Schema.decodeUnknownEffect(
      ProviderBudgetStoreReservationResultSchema,
      { onExcessProperty: "error" },
    )(raw).pipe(
      Effect.mapError(() => enforcementError("policy_stale", true)),
    );
    if (result.outcome !== "reserved") {
      return yield* enforcementError(
        result.outcome,
        result.outcome !== "rate_class_disabled",
        result.retryAtMillis,
      );
    }
    return result;
  });

  const settle = Effect.fn("agentos.providerBudget.settle")(function*(
    untrusted: unknown,
  ) {
    const input = yield* Schema.decodeUnknownEffect(
      ProviderBudgetSettlementInputV1Schema,
      { onExcessProperty: "error" },
    )(untrusted).pipe(
      Effect.mapError(() => enforcementError("invalid_settlement", false)),
    );
    const raw = yield* store.settle(input).pipe(
      Effect.mapError(() => enforcementError("database_unavailable", true)),
    );
    return yield* Schema.decodeUnknownEffect(
      ProviderBudgetSettlementV1Schema,
      { onExcessProperty: "error" },
    )(raw).pipe(
      Effect.mapError(() => enforcementError("policy_stale", true)),
    );
  });

  const settleProvider = Effect.fn(
    "agentos.providerBudget.settleProvider",
  )(function*(untrusted: unknown) {
    const input = yield* Schema.decodeUnknownEffect(
      ProviderBudgetProviderSettlementInputV1Schema,
      { onExcessProperty: "error" },
    )(untrusted).pipe(
      Effect.mapError(() => enforcementError("invalid_settlement", false)),
    );
    const raw = yield* store.settleProvider(input).pipe(
      Effect.mapError(() => enforcementError("database_unavailable", true)),
    );
    return yield* Schema.decodeUnknownEffect(
      ProviderBudgetSettlementV1Schema,
      { onExcessProperty: "error" },
    )(raw).pipe(
      Effect.mapError(() => enforcementError("policy_stale", true)),
    );
  });

  return Layer.succeed(ProviderBudgetEnforcer, {
    reserve,
    settle,
    settleProvider,
  });
}

export const providerBudgetKey = Effect.fn(
  "agentos.providerBudget.key",
)(function*(input: ProviderBudgetReservationInputV1) {
  const crypto = yield* Crypto.Crypto;
  const source = [
    "agentos-provider-budget-v1",
    authorizationSubjectName(input.subject),
    input.provider,
    input.credentialDomain,
    input.capability,
    authorizationResourceName(input.resource),
    input.environment ?? "",
  ].join("\n");
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return `budget_${Encoding.encodeHex(digest)}`;
});
