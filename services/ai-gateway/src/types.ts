export interface UsageWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  accountId: string;
  observedAt: number;
  shortWindow?: UsageWindow;
  weeklyWindow?: UsageWindow;
  stale: boolean;
  planType?: string;
  creditsRemaining?: number;
}

export interface AccountBlock {
  kind: "quota" | "transient";
  retryAt?: number;
}

export interface Candidate {
  accountId: string;
  label: string;
  usage?: UsageSnapshot;
  needsReauth: boolean;
  block?: AccountBlock;
  activeReservations?: number;
}

export interface CandidateExplanation {
  accountId: string;
  eligible: boolean;
  rejectionCode?: string;
  weeklyRemainingPercent?: number;
  shortWindowRemainingPercent?: number;
  urgency?: number;
  freshness: "fresh" | "stale" | "unknown";
  selectedBecause?: string;
}

export interface SelectionDecision {
  accountId?: string;
  reason: string;
  candidates: CandidateExplanation[];
}

export interface RoutingConfig {
  usageFreshnessMs: number;
  reservationTtlMs: number;
  assignmentTtlMs: number;
  scoreHysteresisRatio: number;
  headroom: {
    shortWindowMinimumPercent: number;
    weeklyMinimumPercent: number;
  };
}
