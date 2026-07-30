import { Effect, Option } from "effect"
import { NoEligibleAccountsError } from "./errors.ts"
import {
  type AccountId,
  type Candidate,
  CandidateExplanation,
  type CandidateRejection,
  type RoutingConfig,
  SelectionDecision,
  emptyCandidateExplanation
} from "./model.ts"

export interface SelectAccountInput {
  readonly candidates: ReadonlyArray<Candidate>
  readonly config: RoutingConfig
  readonly now: number
  readonly currentAccountId?: AccountId
}

interface RankedCandidate {
  readonly candidate: Candidate
  readonly freshness: "fresh" | "stale"
  readonly weeklyRemaining: number
  readonly shortRemaining: number
  readonly effectiveWeeklyRemaining: number
  readonly urgency: number
}

const activeBlock = (candidate: Candidate, now: number): boolean =>
  candidate.block !== undefined &&
  (candidate.block.retryAt === undefined || candidate.block.retryAt > now)

const rejectionFor = (
  candidate: Candidate,
  config: RoutingConfig,
  now: number
): CandidateRejection | undefined => {
  if (candidate.requiresReauthentication) {
    return "reauthentication_required"
  }
  if (activeBlock(candidate, now)) {
    return "active_block"
  }
  if (candidate.usage === undefined) {
    return "usage_unknown"
  }

  const age = Math.max(0, now - candidate.usage.observedAt)
  if (age > config.maximumUsageAgeMs) {
    return "usage_too_old"
  }
  if (candidate.usage.weekly.resetAt === undefined) {
    return "weekly_reset_unknown"
  }
  if (candidate.usage.weekly.resetAt <= now) {
    return "weekly_reset_elapsed"
  }

  const shortRemaining = candidate.usage.short.remainingPercent
  const weeklyRemaining = candidate.usage.weekly.remainingPercent
  if (shortRemaining < config.minimumShortRemainingPercent) {
    return "short_headroom"
  }
  if (weeklyRemaining < config.minimumWeeklyRemainingPercent) {
    return "weekly_headroom"
  }
  return undefined
}

const rankCandidate = (
  candidate: Candidate,
  config: RoutingConfig,
  now: number
): RankedCandidate => {
  const usage = candidate.usage
  if (usage === undefined || usage.weekly.resetAt === undefined) {
    throw new Error("rankCandidate called for an ineligible candidate")
  }
  const freshness =
    usage.stale === true || now - usage.observedAt > config.usageFreshnessMs ? "stale" : "fresh"
  const weeklyRemaining = usage.weekly.remainingPercent
  const effectiveWeeklyRemaining = Math.max(
    0,
    weeklyRemaining - (freshness === "stale" ? config.stalePenaltyPercent : 0)
  )
  const hoursUntilReset = (usage.weekly.resetAt - now) / (60 * 60 * 1_000)

  return {
    candidate,
    effectiveWeeklyRemaining,
    freshness,
    shortRemaining: usage.short.remainingPercent,
    urgency: effectiveWeeklyRemaining / Math.max(0.25, hoursUntilReset),
    weeklyRemaining
  }
}

const compareRanked = (left: RankedCandidate, right: RankedCandidate): number => {
  if (left.urgency !== right.urgency) {
    return right.urgency - left.urgency
  }
  if (left.weeklyRemaining !== right.weeklyRemaining) {
    return left.weeklyRemaining - right.weeklyRemaining
  }
  if (left.shortRemaining !== right.shortRemaining) {
    return right.shortRemaining - left.shortRemaining
  }
  if (left.candidate.activeReservations !== right.candidate.activeReservations) {
    return left.candidate.activeReservations - right.candidate.activeReservations
  }
  return left.candidate.accountId.localeCompare(right.candidate.accountId)
}

const explanationForRanked = (ranked: RankedCandidate) =>
  CandidateExplanation.make({
    accountId: ranked.candidate.accountId,
    effectiveWeeklyRemaining: Option.some(ranked.effectiveWeeklyRemaining),
    eligible: true,
    freshness: Option.some(ranked.freshness),
    rejection: Option.none(),
    urgency: Option.some(ranked.urgency)
  })

export const weeklyUrgency = (remainingPercent: number, resetAt: number, now: number): number =>
  remainingPercent / Math.max(0.25, (resetAt - now) / (60 * 60 * 1_000))

export const selectAccount = Effect.fn("selectAccount")(function* (input: SelectAccountInput) {
  const ranked: Array<RankedCandidate> = []
  const explanations: Array<CandidateExplanation> = []

  for (const candidate of input.candidates) {
    const rejection = rejectionFor(candidate, input.config, input.now)
    if (rejection !== undefined) {
      explanations.push(emptyCandidateExplanation(candidate.accountId, rejection))
      continue
    }
    const candidateRank = rankCandidate(candidate, input.config, input.now)
    ranked.push(candidateRank)
    explanations.push(explanationForRanked(candidateRank))
  }

  if (ranked.length === 0) {
    return yield* new NoEligibleAccountsError({
      explanations,
      message: "No account has safe quota and health data"
    })
  }

  const preferredFreshness = ranked.some((item) => item.freshness === "fresh") ? "fresh" : "stale"
  const preferred = ranked
    .filter((item) => item.freshness === preferredFreshness)
    .sort(compareRanked)
  const best = preferred[0]
  if (best === undefined) {
    return yield* new NoEligibleAccountsError({
      explanations,
      message: "No account remains after freshness selection"
    })
  }

  const current =
    input.currentAccountId === undefined
      ? undefined
      : preferred.find((item) => item.candidate.accountId === input.currentAccountId)
  const keepCurrent =
    current !== undefined && current.urgency >= best.urgency * (1 - input.config.hysteresisRatio)
  const selected = keepCurrent ? current : best

  return SelectionDecision.make({
    accountId: selected.candidate.accountId,
    explanations,
    reason: keepCurrent ? "current_account_hysteresis" : "best_candidate"
  })
})
