import { openSqliteRoutingState } from "@akua-dev/codex-router/bun";
import {
  AccountId,
  LeaseToken,
  SessionKey,
  classifyUpstreamResponse,
} from "@akua-dev/codex-router/core";
import { Effect, Option } from "effect";
import {
  selectAccount,
  toRouterCandidate,
  toRouterConfig,
} from "./selection.ts";
import type {
  Candidate,
  CandidateExplanation,
  RoutingConfig,
  SelectionDecision,
} from "./types.ts";

export interface AcquiredReservation {
  accountId: string;
  leaseToken: string;
  expiresAt: number;
  decisionReason: string;
}

export interface RoutingSummary {
  activeReservations: number;
  reservationsByAccount: Record<string, number>;
  lastSelection?: {
    observedAt: number;
    reason: string;
    candidates: CandidateExplanation[];
  };
}

export async function createRoutingState(path: string, config: RoutingConfig) {
  const routerConfig = toRouterConfig(config);
  const handle = await Effect.runPromise(
    openSqliteRoutingState(path, routerConfig),
  );
  let lastSelection: RoutingSummary["lastSelection"];

  return {
    async summary(now: number): Promise<RoutingSummary> {
      const summary = await Effect.runPromise(handle.state.summary(now));
      return {
        activeReservations: summary.activeReservations,
        reservationsByAccount: Object.fromEntries(
          summary.accounts
            .filter((account) => account.activeReservations > 0)
            .map((account) => [account.accountId, account.activeReservations]),
        ),
        ...(lastSelection ? { lastSelection } : {}),
      };
    },

    async acquire(input: {
      candidates: Candidate[];
      now: number;
      sessionKey?: string;
    }): Promise<AcquiredReservation | undefined> {
      let summary = await Effect.runPromise(handle.state.summary(input.now));
      const recoveredAccounts = summary.accounts.filter(
        (account) =>
          account.requiresReauthentication &&
          input.candidates.some(
            (candidate) =>
              candidate.accountId === account.accountId &&
              !candidate.needsReauth,
          ),
      );
      for (const account of recoveredAccounts) {
        await Effect.runPromise(
          handle.state.recordResponse(
            account.accountId,
            classifyUpstreamResponse(200, new Headers(), input.now),
            input.now,
          ),
        );
      }
      if (recoveredAccounts.length > 0) {
        summary = await Effect.runPromise(handle.state.summary(input.now));
      }
      const diagnosticCandidates = overlayRoutingSummary(
        input.candidates,
        summary,
      );
      const decision = selectAccount({
        candidates: diagnosticCandidates,
        config,
        now: input.now,
      });
      const lease = await Effect.runPromise(
        handle.state.acquire({
          candidates: input.candidates.map(toRouterCandidate),
          now: input.now,
          ...(input.sessionKey
            ? { sessionKey: SessionKey.make(input.sessionKey) }
            : {}),
        }),
      );
      const acquired = Option.getOrUndefined(lease);
      const decisionReason =
        acquired === undefined
          ? decision.reason
          : acquired.accountId === decision.accountId
            ? decision.reason
            : "current_account_hysteresis";
      lastSelection = {
        observedAt: input.now,
        reason: decisionReason,
        candidates: decision.candidates,
      };
      if (acquired === undefined) return undefined;
      return {
        accountId: acquired.accountId,
        leaseToken: acquired.leaseToken,
        expiresAt: acquired.expiresAt,
        decisionReason,
      };
    },

    async evaluate(input: {
      candidates: Candidate[];
      now: number;
    }): Promise<SelectionDecision> {
      const summary = await Effect.runPromise(handle.state.summary(input.now));
      return selectAccount({
        candidates: overlayRoutingSummary(
          input.candidates,
          summary,
          true,
        ),
        config,
        now: input.now,
      });
    },

    async renew(leaseToken: string, now: number): Promise<boolean> {
      return await Effect.runPromise(
        handle.state.renew(LeaseToken.make(leaseToken), now),
      );
    },

    async release(leaseToken: string): Promise<boolean> {
      await Effect.runPromise(
        handle.state.release(LeaseToken.make(leaseToken)),
      );
      return true;
    },

    async recordResponse(
      accountId: string,
      status: number,
      headers: Headers,
      now: number,
    ): Promise<void> {
      await Effect.runPromise(
        handle.state.recordResponse(
          AccountId.make(accountId),
          classifyUpstreamResponse(status, headers, now),
          now,
        ),
      );
    },

    async close(): Promise<void> {
      await Effect.runPromise(handle.close);
    },
  };
}

function overlayRoutingSummary(
  candidates: Candidate[],
  summary: {
    accounts: ReadonlyArray<{
      accountId: string;
      activeReservations: number;
      blockKind: Option.Option<"quota" | "transient">;
      requiresReauthentication: boolean;
    }>;
  },
  recoverFreshCredentials = false,
): Candidate[] {
  return candidates.map((candidate) => {
    const account = summary.accounts.find(
      (value) => value.accountId === candidate.accountId,
    );
    const blockKind = account
      ? Option.getOrUndefined(account.blockKind)
      : undefined;
    return {
      ...candidate,
      activeReservations:
        (candidate.activeReservations ?? 0) +
        (account?.activeReservations ?? 0),
      needsReauth:
        candidate.needsReauth ||
        (account?.requiresReauthentication === true &&
          !recoverFreshCredentials),
      ...(candidate.block
        ? { block: candidate.block }
        : blockKind
          ? {
              block: {
                kind: blockKind,
              },
            }
          : {}),
    };
  });
}
