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
  accountId: string;
  kind: "quota" | "auth" | "transient";
  blockedAt: number;
  retryAt?: number;
}

export interface Candidate {
  accountId: string;
  label: string;
  usage?: UsageSnapshot;
  needsReauth: boolean;
  block?: AccountBlock;
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

export interface Reservation {
  accountId: string;
  leaseToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionAssignment {
  sessionKey: string;
  accountId: string;
  updatedAt: number;
}

export interface RoutingStateFile {
  version: 1;
  reservations: Reservation[];
  assignments: SessionAssignment[];
  blocks: AccountBlock[];
}

export type RouteLease =
  | {
      kind: "codex_oauth";
      accountId: string;
      providerAccountId: string;
      accessToken: string;
      leaseToken: string;
      renew(): Promise<boolean>;
      release(): Promise<void>;
      recordResponse?(status: number, headers: Headers): Promise<void>;
    }
  | {
      kind: "openai_api_key";
      accountId: "openai-api-key";
      accessToken: string;
      leaseToken: "api-key";
      renew(): Promise<boolean>;
      release(): Promise<void>;
      recordResponse?(status: number, headers: Headers): Promise<void>;
    };
