import {
  AccountBlock,
  AccountId,
  Candidate as RouterCandidate,
  UsageSnapshot as RouterUsageSnapshot,
  UsageWindow as RouterUsageWindow,
  defaultRoutingConfig as routerDefaultRoutingConfig,
  selectAccount as selectRouterAccount,
  weeklyUrgency as routerWeeklyUrgency,
  type CandidateExplanation as RouterCandidateExplanation,
  type RoutingConfig as RouterRoutingConfig,
} from "@akua-dev/codex-router-core";
import { Effect, Option, Result } from "effect";
import type {
  Candidate,
  CandidateExplanation,
  RoutingConfig,
  SelectionDecision,
  UsageSnapshot,
} from "./types.ts";

export const defaultRoutingConfig: RoutingConfig = {
  usageFreshnessMs: routerDefaultRoutingConfig.usageFreshnessMs,
  reservationTtlMs: routerDefaultRoutingConfig.leaseTtlMs,
  assignmentTtlMs: routerDefaultRoutingConfig.assignmentTtlMs,
  scoreHysteresisRatio: routerDefaultRoutingConfig.hysteresisRatio,
  headroom: {
    shortWindowMinimumPercent:
      routerDefaultRoutingConfig.minimumShortRemainingPercent,
    weeklyMinimumPercent:
      routerDefaultRoutingConfig.minimumWeeklyRemainingPercent,
  },
};

export interface SelectionInput {
  candidates: Candidate[];
  config: RoutingConfig;
  now: number;
  currentAccountId?: string;
}

export function toRouterConfig(config: RoutingConfig): RouterRoutingConfig {
  return {
    usageFreshnessMs: config.usageFreshnessMs,
    maximumUsageAgeMs: routerDefaultRoutingConfig.maximumUsageAgeMs,
    stalePenaltyPercent: routerDefaultRoutingConfig.stalePenaltyPercent,
    minimumShortRemainingPercent: config.headroom.shortWindowMinimumPercent,
    minimumWeeklyRemainingPercent: config.headroom.weeklyMinimumPercent,
    hysteresisRatio: config.scoreHysteresisRatio,
    assignmentTtlMs: config.assignmentTtlMs,
    leaseTtlMs: config.reservationTtlMs,
  };
}

function toRouterUsage(candidate: Candidate): RouterUsageSnapshot | undefined {
  const usage = candidate.usage;
  if (!usage?.shortWindow || !usage.weeklyWindow) return undefined;
  return RouterUsageSnapshot.make({
    accountId: AccountId.make(candidate.accountId),
    observedAt: usage.observedAt,
    short: RouterUsageWindow.make({
      usedPercent: usage.shortWindow.usedPercent,
      ...(usage.shortWindow.resetsAt === undefined
        ? {}
        : { resetAt: usage.shortWindow.resetsAt }),
    }),
    weekly: RouterUsageWindow.make({
      usedPercent: usage.weeklyWindow.usedPercent,
      ...(usage.weeklyWindow.resetsAt === undefined
        ? {}
        : { resetAt: usage.weeklyWindow.resetsAt }),
    }),
    stale: usage.stale,
    ...(usage.planType === undefined ? {} : { planType: usage.planType }),
    ...(usage.creditsRemaining === undefined
      ? {}
      : { credits: usage.creditsRemaining }),
  });
}

export function toRouterCandidate(candidate: Candidate): RouterCandidate {
  const usage = toRouterUsage(candidate);
  const block = candidate.block
    ? AccountBlock.make({
        kind: candidate.block.kind,
        ...(candidate.block.retryAt === undefined
          ? {}
          : { retryAt: candidate.block.retryAt }),
      })
    : undefined;
  return RouterCandidate.make({
    accountId: AccountId.make(candidate.accountId),
    activeReservations: candidate.activeReservations ?? 0,
    requiresReauthentication: candidate.needsReauth,
    ...(candidate.label ? { label: candidate.label } : {}),
    ...(usage ? { usage } : {}),
    ...(block ? { block } : {}),
  });
}

export function fromRouterExplanation(
  value: RouterCandidateExplanation,
): CandidateExplanation {
  const freshness = Option.getOrUndefined(value.freshness) ?? "unknown";
  const rejectionCode = Option.getOrUndefined(value.rejection);
  const weeklyRemainingPercent = Option.getOrUndefined(
    value.effectiveWeeklyRemaining,
  );
  const urgency = Option.getOrUndefined(value.urgency);
  return {
    accountId: value.accountId,
    eligible: value.eligible,
    freshness,
    ...(rejectionCode === undefined ? {} : { rejectionCode }),
    ...(weeklyRemainingPercent === undefined ? {} : { weeklyRemainingPercent }),
    ...(urgency === undefined ? {} : { urgency }),
  };
}

export function weeklyUrgency(snapshot: UsageSnapshot, now: number): number {
  const weekly = snapshot.weeklyWindow;
  if (weekly?.resetsAt === undefined || weekly.resetsAt <= now) return 0;
  return routerWeeklyUrgency(
    Math.max(0, 100 - weekly.usedPercent),
    weekly.resetsAt,
    now,
  );
}

export function selectAccount(input: SelectionInput): SelectionDecision {
  const result = Effect.runSync(
    Effect.result(
      selectRouterAccount({
        candidates: input.candidates.map(toRouterCandidate),
        config: toRouterConfig(input.config),
        now: input.now,
        ...(input.currentAccountId === undefined
          ? {}
          : { currentAccountId: AccountId.make(input.currentAccountId) }),
      }),
    ),
  );
  if (Result.isFailure(result)) {
    return {
      reason: "no_eligible_accounts",
      candidates: result.failure.explanations.map(fromRouterExplanation),
    };
  }
  return {
    accountId: result.success.accountId,
    reason: result.success.reason,
    candidates: result.success.explanations.map(fromRouterExplanation),
  };
}
