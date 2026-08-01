import { Context, Effect, Schema } from "effect";

import type {
  Candidate,
  CandidateExplanation,
  SelectionDecision,
} from "./types.ts";

const AIRoutingStateErrorCode = Schema.Literals([
  "state_unavailable",
]);

export class AIRoutingStateError extends Schema.TaggedErrorClass<AIRoutingStateError>()(
  "AIRoutingStateError",
  { code: AIRoutingStateErrorCode },
) {}

export interface AIRoutingAcquireInput {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly now: number;
  readonly sessionKey?: string;
}

export interface AIRoutingEvaluateInput {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly now: number;
}

export interface AIAcquiredReservation {
  readonly accountId: string;
  readonly leaseToken: string;
  readonly expiresAt: number;
  readonly decisionReason: string;
}

export interface AIRoutingSummary {
  readonly activeReservations: number;
  readonly reservationsByAccount: Readonly<Record<string, number>>;
  readonly lastSelection?: {
    readonly observedAt: number;
    readonly reason: string;
    readonly candidates: ReadonlyArray<CandidateExplanation>;
  };
}

export class AIRoutingState extends Context.Service<
  AIRoutingState,
  {
    readonly summary: (
      now: number,
    ) => Effect.Effect<AIRoutingSummary, AIRoutingStateError>;
    readonly acquire: (
      input: AIRoutingAcquireInput,
    ) => Effect.Effect<AIAcquiredReservation | undefined, AIRoutingStateError>;
    readonly evaluate: (
      input: AIRoutingEvaluateInput,
    ) => Effect.Effect<SelectionDecision, AIRoutingStateError>;
    readonly renew: (
      leaseToken: string,
      now: number,
    ) => Effect.Effect<boolean, AIRoutingStateError>;
    readonly release: (
      leaseToken: string,
    ) => Effect.Effect<boolean, AIRoutingStateError>;
    readonly recordResponse: (
      accountId: string,
      status: number,
      headers: Headers,
      now: number,
    ) => Effect.Effect<void, AIRoutingStateError>;
  }
>()("agentos/ai-gateway/AIRoutingState") {}
