import { Option, Schema } from "effect"

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

export const ProviderAccountId = Schema.String.pipe(Schema.brand("ProviderAccountId"))
export type ProviderAccountId = typeof ProviderAccountId.Type

export const SessionKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand("SessionKey")
)
export type SessionKey = typeof SessionKey.Type

export const LeaseToken = Schema.String.pipe(Schema.brand("LeaseToken"))
export type LeaseToken = typeof LeaseToken.Type

export class UsageWindow extends Schema.Class<UsageWindow>("UsageWindow")({
  usedPercent: Schema.Number,
  resetAt: Schema.optionalKey(Schema.Number)
}) {
  get remainingPercent(): number {
    return Math.max(0, 100 - this.usedPercent)
  }
}

export class UsageSnapshot extends Schema.Class<UsageSnapshot>("UsageSnapshot")({
  accountId: AccountId,
  observedAt: Schema.Number,
  short: UsageWindow,
  weekly: UsageWindow,
  stale: Schema.optionalKey(Schema.Boolean),
  planType: Schema.optionalKey(Schema.String),
  credits: Schema.optionalKey(Schema.Number)
}) {}

export class AccountBlock extends Schema.Class<AccountBlock>("AccountBlock")({
  kind: Schema.Literals(["quota", "transient"]),
  retryAt: Schema.optionalKey(Schema.Number)
}) {}

export class Candidate extends Schema.Class<Candidate>("Candidate")({
  accountId: AccountId,
  label: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(UsageSnapshot),
  requiresReauthentication: Schema.Boolean,
  block: Schema.optionalKey(AccountBlock),
  activeReservations: Schema.Number
}) {}

export const CandidateRejection = Schema.Literals([
  "reauthentication_required",
  "active_block",
  "usage_unknown",
  "usage_too_old",
  "weekly_reset_unknown",
  "weekly_reset_elapsed",
  "short_headroom",
  "weekly_headroom"
])
export type CandidateRejection = typeof CandidateRejection.Type

export class CandidateExplanation extends Schema.Class<CandidateExplanation>(
  "CandidateExplanation"
)({
  accountId: AccountId,
  eligible: Schema.Boolean,
  rejection: Schema.Option(CandidateRejection),
  freshness: Schema.Option(Schema.Literals(["fresh", "stale"])),
  urgency: Schema.Option(Schema.Number),
  effectiveWeeklyRemaining: Schema.Option(Schema.Number)
}) {}

export const SelectionReason = Schema.Literals(["best_candidate", "current_account_hysteresis"])
export type SelectionReason = typeof SelectionReason.Type

export class SelectionDecision extends Schema.Class<SelectionDecision>("SelectionDecision")({
  accountId: AccountId,
  reason: SelectionReason,
  explanations: Schema.Array(CandidateExplanation)
}) {}

export class SessionAssignment extends Schema.Class<SessionAssignment>("SessionAssignment")({
  sessionKey: SessionKey,
  accountId: AccountId,
  updatedAt: Schema.Number
}) {}

export class Reservation extends Schema.Class<Reservation>("Reservation")({
  leaseToken: LeaseToken,
  accountId: AccountId,
  sessionKey: Schema.Option(SessionKey),
  createdAt: Schema.Number,
  expiresAt: Schema.Number
}) {}

export class RouteLease extends Schema.Class<RouteLease>("RouteLease")({
  leaseToken: LeaseToken,
  accountId: AccountId,
  sessionKey: Schema.Option(SessionKey),
  expiresAt: Schema.Number
}) {}

export class AccountRoutingSummary extends Schema.Class<AccountRoutingSummary>(
  "AccountRoutingSummary"
)({
  accountId: AccountId,
  activeReservations: Schema.Number,
  requiresReauthentication: Schema.Boolean,
  blockKind: Schema.Option(Schema.Literals(["quota", "transient"]))
}) {}

export class RoutingSummary extends Schema.Class<RoutingSummary>("RoutingSummary")({
  activeReservations: Schema.Number,
  assignments: Schema.Number,
  accounts: Schema.Array(AccountRoutingSummary)
}) {}

export interface RoutingConfig {
  readonly usageFreshnessMs: number
  readonly maximumUsageAgeMs: number
  readonly stalePenaltyPercent: number
  readonly minimumShortRemainingPercent: number
  readonly minimumWeeklyRemainingPercent: number
  readonly hysteresisRatio: number
  readonly assignmentTtlMs: number
  readonly leaseTtlMs: number
}

export const defaultRoutingConfig: RoutingConfig = {
  usageFreshnessMs: 60_000,
  maximumUsageAgeMs: 24 * 60 * 60 * 1_000,
  stalePenaltyPercent: 5,
  minimumShortRemainingPercent: 10,
  minimumWeeklyRemainingPercent: 3,
  hysteresisRatio: 0.1,
  assignmentTtlMs: 7 * 24 * 60 * 60 * 1_000,
  leaseTtlMs: 120_000
}

export const emptyCandidateExplanation = (accountId: AccountId, rejection: CandidateRejection) =>
  CandidateExplanation.make({
    accountId,
    effectiveWeeklyRemaining: Option.none(),
    eligible: false,
    freshness: Option.none(),
    rejection: Option.some(rejection),
    urgency: Option.none()
  })
