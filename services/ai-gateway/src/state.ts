import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { Context, Effect, Layer, Schema } from "effect";

import {
  AccountNeedsReauthError,
  AccountNotFoundError,
  InvalidCodexTokenError,
  TokenRefreshTransientError,
  type AccountVault,
  type FreshCredential,
  type ManagedAccountSummary,
} from "./accounts.ts";
import type {
  Candidate,
  CandidateExplanation,
  SelectionDecision,
} from "./types.ts";

const ManagedAccountVaultErrorCode = Schema.Literals([
  "account_not_found",
  "needs_reauthentication",
  "invalid_credential",
  "refresh_transient",
  "interrupted",
  "storage_unavailable",
]);

export class ManagedAccountVaultError extends Schema.TaggedErrorClass<ManagedAccountVaultError>()(
  "ManagedAccountVaultError",
  { code: ManagedAccountVaultErrorCode },
) {}

export class ManagedAccountVault extends Context.Service<
  ManagedAccountVault,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<ManagedAccountSummary>,
      ManagedAccountVaultError
    >;
    readonly addFromOAuth: (
      label: string,
      credentials: OAuthCredentials,
    ) => Effect.Effect<string, ManagedAccountVaultError>;
    readonly getFreshCredential: (
      id: string,
    ) => Effect.Effect<FreshCredential, ManagedAccountVaultError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<boolean, ManagedAccountVaultError>;
    readonly markNeedsReauth: (
      id: string,
      rejectedAccessToken?: string,
    ) => Effect.Effect<boolean, ManagedAccountVaultError>;
  }
>()("agentos/ai-gateway/ManagedAccountVault") {}

export function makeManagedAccountVaultLayer(vault: AccountVault) {
  return Layer.succeed(ManagedAccountVault, ManagedAccountVault.of({
    list: accountPromise(() => vault.list()),
    addFromOAuth: (label, credentials) =>
      accountPromise(() => vault.addFromOAuth(label, credentials)),
    getFreshCredential: (id) =>
      accountPromise((signal) => vault.getFreshCredential(id, signal)),
    remove: (id) => accountPromise(() => vault.remove(id)),
    markNeedsReauth: (id, rejectedAccessToken) =>
      accountPromise(() => vault.markNeedsReauth(id, rejectedAccessToken)),
  }));
}

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

export interface AIRoutingStateHandle {
  readonly summary: (now: number) => Promise<AIRoutingSummary>;
  readonly acquire: (
    input: {
      readonly candidates: Array<Candidate>;
      readonly now: number;
      readonly sessionKey?: string;
    },
  ) => Promise<AIAcquiredReservation | undefined>;
  readonly evaluate: (
    input: {
      readonly candidates: Array<Candidate>;
      readonly now: number;
    },
  ) => Promise<SelectionDecision>;
  readonly renew: (leaseToken: string, now: number) => Promise<boolean>;
  readonly release: (leaseToken: string) => Promise<boolean>;
  readonly recordResponse: (
    accountId: string,
    status: number,
    headers: Headers,
    now: number,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
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

export function makeAIRoutingStateLayer(
  openRouting: () => Promise<AIRoutingStateHandle>,
) {
  const open = routingPromise(openRouting);
  return Layer.effect(
    AIRoutingState,
    Effect.acquireRelease(
      open,
      (routing) =>
        Effect.tryPromise({
          try: () => routing.close(),
          catch: () => routingError(),
        }).pipe(
          Effect.catchCause(() => Effect.void),
        ),
    ).pipe(Effect.map(routingService)),
  );
}

function routingService(routing: AIRoutingStateHandle) {
  return AIRoutingState.of({
    summary: (now) => routingPromise(() => routing.summary(now)),
    acquire: (input) => routingPromise(() => routing.acquire({
      candidates: [...input.candidates],
      now: input.now,
      ...(input.sessionKey === undefined
        ? {}
        : { sessionKey: input.sessionKey }),
    })),
    evaluate: (input) => routingPromise(() => routing.evaluate({
      candidates: [...input.candidates],
      now: input.now,
    })),
    renew: (leaseToken, now) =>
      routingPromise(() => routing.renew(leaseToken, now)),
    release: (leaseToken) =>
      routingPromise(() => routing.release(leaseToken)),
    recordResponse: (accountId, status, headers, now) =>
      routingPromise(() =>
        routing.recordResponse(accountId, status, headers, now)
      ),
  });
}

function accountPromise<A>(
  operation: (signal: AbortSignal) => Promise<A>,
) {
  return Effect.tryPromise({
    try: operation,
    catch: accountError,
  });
}

function accountError(cause: unknown) {
  const code: ManagedAccountVaultError["code"] =
    cause instanceof AccountNotFoundError
      ? "account_not_found"
      : cause instanceof AccountNeedsReauthError
        ? "needs_reauthentication"
        : cause instanceof InvalidCodexTokenError
          ? "invalid_credential"
          : cause instanceof TokenRefreshTransientError
            ? "refresh_transient"
            : cause instanceof DOMException && cause.name === "AbortError"
              ? "interrupted"
              : "storage_unavailable";
  return ManagedAccountVaultError.make({ code });
}

function routingPromise<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: () => routingError(),
  });
}

function routingError() {
  return AIRoutingStateError.make({ code: "state_unavailable" });
}
