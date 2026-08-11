import { sqliteRoutingStateLayer } from "@akua-dev/codex-router/bun";
import {
  AccountId,
  LeaseToken,
  RoutingState as CodexRoutingState,
  SessionKey,
  classifyUpstreamResponse,
} from "@akua-dev/codex-router/core";
import {
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
} from "effect";

import {
  selectAccount,
  toRouterCandidate,
  toRouterConfig,
} from "./selection.ts";
import {
  AIRoutingState,
  AIRoutingStateError,
  type AIRoutingSummary,
} from "./routing-service.ts";
import type {
  Candidate,
  RoutingConfig,
  SelectionDecision,
} from "./types.ts";

type LastSelection = NonNullable<AIRoutingSummary["lastSelection"]>;

export function makeEffectAIRoutingStateLayer(
  path: string,
  config: RoutingConfig,
  routingLayer: Layer.Layer<CodexRoutingState, unknown> =
    sqliteRoutingStateLayer(
    path,
    toRouterConfig(config),
  ),
) {
  return Layer.effect(
    AIRoutingState,
    Effect.gen(function*() {
      const routing = yield* CodexRoutingState;
      const lastSelection = yield* Ref.make<Option.Option<LastSelection>>(
        Option.none(),
      );
      const releaseRoutingLease = (leaseToken: LeaseToken) =>
        routing.release(leaseToken).pipe(
          Effect.asVoid,
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
        );

      const summary: AIRoutingState["Service"]["summary"] = (now) =>
        routeEffect(Effect.gen(function*() {
          const durable = yield* routing.summary(now);
          const diagnostic = yield* Ref.get(lastSelection);
          return {
            activeReservations: durable.activeReservations,
            reservationsByAccount: Object.fromEntries(
              durable.accounts
                .filter((account) => account.activeReservations > 0)
                .map((account) => [
                  account.accountId,
                  account.activeReservations,
                ]),
            ),
            ...(Option.isSome(diagnostic)
              ? { lastSelection: diagnostic.value }
              : {}),
          };
        }));

      const acquire: AIRoutingState["Service"]["acquire"] = (input, use) =>
        Effect.gen(function*() {
          let durable = yield* routeEffect(routing.summary(input.now));
          const recovered = durable.accounts.filter((account) =>
            account.requiresReauthentication &&
            input.candidates.some((candidate) =>
              candidate.accountId === account.accountId &&
              !candidate.needsReauth
            )
          );
          yield* routeEffect(Effect.forEach(
            recovered,
            (account) =>
              routing.recordResponse(
                account.accountId,
                classifyUpstreamResponse(200, new Headers(), input.now),
                input.now,
              ),
            { discard: true },
          ));
          if (recovered.length > 0) {
            durable = yield* routeEffect(routing.summary(input.now));
          }
          const diagnosticCandidates = overlayRoutingSummary(
            input.candidates,
            durable,
          );
          const decision = yield* routeEffect(selectEffect(
            diagnosticCandidates,
            config,
            input.now,
          ));
          const transferred = yield* Ref.make(false);
          return yield* Effect.acquireUseRelease(
            routing.acquire({
              candidates: input.candidates.map(toRouterCandidate),
              now: input.now,
              ...(input.sessionKey === undefined
                ? {}
                : { sessionKey: SessionKey.make(input.sessionKey) }),
            }).pipe(
              Effect.mapError(() =>
                AIRoutingStateError.make({ code: "state_unavailable" })
              ),
            ),
            (lease) => Effect.gen(function*() {
              const acquired = Option.getOrUndefined(lease);
              const decisionReason = acquired === undefined
                ? decision.reason
                : acquired.accountId === decision.accountId
                  ? decision.reason
                  : "current_account_hysteresis";
              yield* Ref.set(lastSelection, Option.some({
                observedAt: input.now,
                reason: decisionReason,
                candidates: decision.candidates,
              }));
              const transfer = Effect.uninterruptible(
                Ref.set(transferred, true),
              );
              return yield* use(
                acquired === undefined
                  ? undefined
                  : {
                      accountId: acquired.accountId,
                      leaseToken: acquired.leaseToken,
                      expiresAt: acquired.expiresAt,
                      decisionReason,
                    },
                transfer,
              );
            }),
            (lease, exit) => Effect.uninterruptible(Effect.gen(function*() {
              const acquired = Option.getOrUndefined(lease);
              if (acquired === undefined) return;
              const wasTransferred = yield* Ref.get(transferred);
              if (wasTransferred && exit._tag === "Success") return;
              yield* routeEffect(releaseRoutingLease(acquired.leaseToken)).pipe(
                Effect.catchCause(() => Effect.void),
              );
            })),
          );
        });

      const evaluate: AIRoutingState["Service"]["evaluate"] = (input) =>
        routeEffect(Effect.gen(function*() {
          const durable = yield* routing.summary(input.now);
          return yield* selectEffect(
            overlayRoutingSummary(
              input.candidates,
              durable,
              true,
            ),
            config,
            input.now,
          );
        }));

      return AIRoutingState.of({
        summary,
        acquire,
        evaluate,
        renew: (leaseToken, now) =>
          routeEffect(routing.renew(LeaseToken.make(leaseToken), now)),
        release: (leaseToken) =>
          routeEffect(releaseRoutingLease(LeaseToken.make(leaseToken))).pipe(
            Effect.as(true),
          ),
        recordResponse: (accountId, status, headers, now) =>
          routeEffect(routing.recordResponse(
            AccountId.make(accountId),
            classifyUpstreamResponse(status, headers, now),
            now,
          )),
      });
    }),
  ).pipe(Layer.provide(routingLayer));
}

function overlayRoutingSummary(
  candidates: ReadonlyArray<Candidate>,
  summary: {
    readonly accounts: ReadonlyArray<{
      readonly accountId: string;
      readonly activeReservations: number;
      readonly blockKind: Option.Option<"quota" | "transient">;
      readonly requiresReauthentication: boolean;
    }>;
  },
  recoverFreshCredentials = false,
): Array<Candidate> {
  return candidates.map((candidate) => {
    const account = summary.accounts.find(
      (value) => value.accountId === candidate.accountId,
    );
    const blockKind = account === undefined
      ? undefined
      : Option.getOrUndefined(account.blockKind);
    return {
      ...candidate,
      activeReservations:
        (candidate.activeReservations ?? 0) +
        (account?.activeReservations ?? 0),
      needsReauth:
        candidate.needsReauth ||
        (account?.requiresReauthentication === true &&
          !recoverFreshCredentials),
      ...(candidate.block !== undefined
        ? { block: candidate.block }
        : blockKind === undefined
          ? {}
          : { block: { kind: blockKind } }),
    };
  });
}

function routeEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError(() =>
    AIRoutingStateError.make({ code: "state_unavailable" })
  ));
}

function selectEffect(
  candidates: Array<Candidate>,
  config: RoutingConfig,
  now: number,
): Effect.Effect<SelectionDecision> {
  return selectAccount({ candidates, config, now });
}
