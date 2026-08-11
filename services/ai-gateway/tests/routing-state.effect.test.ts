import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  AccountId,
  LeaseToken,
  RouteLease,
  RoutingState as CodexRoutingState,
  RoutingStateError,
  RoutingSummary,
} from "@akua-dev/codex-router/core";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
} from "effect";
import { TestClock } from "effect/testing";

import { makeEffectAIRoutingStateLayer } from "../src/effect-routing-state.ts";
import { defaultRoutingConfig } from "../src/selection.ts";
import { AIRoutingState } from "../src/routing-service.ts";
import type { Candidate, RoutingConfig } from "../src/types.ts";

const now = Date.UTC(2026, 6, 19);
const candidates: ReadonlyArray<Candidate> = [
  {
    accountId: "a",
    label: "A",
    needsReauth: false,
    usage: {
      accountId: "a",
      observedAt: now,
      stale: false,
      shortWindow: { usedPercent: 10, resetsAt: now + 3_600_000 },
      weeklyWindow: {
        usedPercent: 20,
        resetsAt: now + 24 * 3_600_000,
      },
    },
  },
  {
    accountId: "b",
    label: "B",
    needsReauth: false,
    usage: {
      accountId: "b",
      observedAt: now,
      stale: false,
      shortWindow: { usedPercent: 10, resetsAt: now + 3_600_000 },
      weeklyWindow: {
        usedPercent: 20,
        resetsAt: now + 48 * 3_600_000,
      },
    },
  },
];

function useRouting<A, E, R>(
  path: string,
  config: RoutingConfig,
  operation: (routing: AIRoutingState["Service"]) => Effect.Effect<A, E, R>,
  routingLayer?: Layer.Layer<CodexRoutingState>,
) {
  return Effect.scoped(Effect.gen(function*() {
    const routing = yield* AIRoutingState;
    return yield* operation(routing);
  }).pipe(Effect.provide(makeEffectAIRoutingStateLayer(
    path,
    config,
    routingLayer,
  ))));
}

describe("Effect canonical durable routing state", () => {
  it.effect("persists explicit stickiness and scopes renew and release", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-routing-",
      });
      const path = `${root}/routing.sqlite`;
      const first = yield* useRouting(
        path,
        defaultRoutingConfig,
        (routing) =>
          Effect.gen(function*() {
            return yield* routing.acquire({
              candidates,
              now,
              sessionKey: "session-1",
            }, (acquired) => Effect.gen(function*() {
              assert.isDefined(acquired);
              if (acquired === undefined) return undefined;
              assert.strictEqual(acquired.accountId, "a");
              assert.strictEqual(
                yield* routing.renew(acquired.leaseToken, now + 30_000),
                true,
              );
              const summary = yield* routing.summary(now + 1);
              assert.strictEqual(summary.activeReservations, 1);
              assert.deepStrictEqual(summary.reservationsByAccount, { a: 1 });
              assert.strictEqual(summary.lastSelection?.reason, "best_candidate");
              assert.strictEqual(
                summary.lastSelection?.candidates.some((candidate) =>
                  candidate.accountId === "a" && candidate.eligible
                ),
                true,
              );
              return acquired;
            }));
          }),
      );
      assert.isDefined(first);

      const sticky = yield* useRouting(
        path,
        defaultRoutingConfig,
        (routing) =>
          routing.acquire({
            candidates,
            now: now + 30_001,
            sessionKey: "session-1",
          }, (acquired) => Effect.succeed(acquired)),
      );
      assert.strictEqual(sticky?.accountId, "a");
    }).pipe(Effect.provide(BunFileSystem.layer))));

  it.effect("preserves successful use when lease cleanup fails", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(useRouting(
        "unused",
        defaultRoutingConfig,
        (routing) =>
          routing.acquire({ candidates, now }, (acquired) =>
            Effect.gen(function*() {
              assert.isDefined(acquired);
              if (acquired === undefined) {
                return new Response(null, { status: 503 });
              }
              return new Response(null, {
                status: 429,
                headers: { "retry-after": "7" },
              });
            })
          ),
        Layer.succeed(CodexRoutingState, {
          acquire: () => Effect.succeed(Option.some(RouteLease.make({
            accountId: AccountId.make("a"),
            expiresAt: now + 60_000,
            leaseToken: LeaseToken.make("lease-token"),
            sessionKey: Option.none(),
          }))),
          recordResponse: () => Effect.void,
          release: () => Effect.fail(RoutingStateError.make({
            message: "cleanup failed",
          })),
          renew: () => Effect.succeed(true),
          summary: () => Effect.succeed(RoutingSummary.make({
            activeReservations: 0,
            accounts: [],
            assignments: 0,
          })),
        }),
      ));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(5_001);
      const response = yield* Fiber.join(fiber);
      assert.strictEqual(response.status, 429);
      assert.strictEqual(response.headers.get("retry-after"), "7");
    }));

  it.effect("expires leases without inventing implicit stickiness", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-routing-",
      });
      yield* useRouting(
        `${root}/routing.sqlite`,
        { ...defaultRoutingConfig, reservationTtlMs: 10 },
        (routing) =>
          Effect.gen(function*() {
            assert.isDefined(yield* routing.acquire(
              { candidates, now },
              (acquired) => Effect.succeed(acquired),
            ));
            yield* routing.acquire(
              { candidates, now: now + 11 },
              (acquired) => Effect.gen(function*() {
                assert.isDefined(acquired);
                assert.strictEqual(
                  (yield* routing.summary(now + 11)).activeReservations,
                  1,
                );
              }),
            );
          }),
      );
    }).pipe(Effect.provide(BunFileSystem.layer))));

  it.effect("uses durable reservation pressure as the deterministic tie break", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-routing-",
      });
      const tied = candidates.map((candidate) => ({
        ...candidate,
        usage: candidate.usage === undefined
          ? undefined
          : {
              ...candidate.usage,
              weeklyWindow: {
                usedPercent: 20,
                resetsAt: now + 24 * 3_600_000,
              },
            },
      }));
      yield* useRouting(
        `${root}/routing.sqlite`,
        defaultRoutingConfig,
        (routing) =>
          Effect.gen(function*() {
            yield* routing.acquire({ candidates: tied, now }, (first) =>
              routing.acquire({
                candidates: tied,
                now: now + 1,
              }, (second) => Effect.sync(() => {
                assert.strictEqual(first?.accountId, "a");
                assert.strictEqual(first?.decisionReason, "best_candidate");
                assert.strictEqual(second?.accountId, "b");
                assert.strictEqual(second?.decisionReason, "best_candidate");
              }))
            );
          }),
      );
    }).pipe(Effect.provide(BunFileSystem.layer))));

  it.effect("retains bounded rejection diagnostics for protected status", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-routing-",
      });
      yield* useRouting(
        `${root}/routing.sqlite`,
        defaultRoutingConfig,
        (routing) =>
          Effect.gen(function*() {
            assert.isUndefined(yield* routing.acquire({
              candidates: [{
                accountId: "reauth",
                label: "Reauth",
                needsReauth: true,
              }],
              now,
            }, (acquired) => Effect.gen(function*() {
              assert.isUndefined(acquired);
              const summary = yield* routing.summary(now);
              assert.strictEqual(
                summary.lastSelection?.reason,
                "no_eligible_accounts",
              );
              assert.deepStrictEqual(summary.lastSelection?.candidates, [{
                accountId: "reauth",
                eligible: false,
                freshness: "unknown",
                rejectionCode: "reauthentication_required",
              }]);
              return acquired;
            })));
          }),
      );
    }).pipe(Effect.provide(BunFileSystem.layer))));

  it.effect("evaluates eligibility without acquiring a lease", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-routing-",
      });
      yield* useRouting(
        `${root}/routing.sqlite`,
        defaultRoutingConfig,
        (routing) =>
          Effect.gen(function*() {
            const decision = yield* routing.evaluate({ candidates, now });
            assert.strictEqual(decision.accountId, "a");
            assert.strictEqual(decision.reason, "best_candidate");
            assert.deepStrictEqual(yield* routing.summary(now), {
              activeReservations: 0,
              reservationsByAccount: {},
            });
          }),
      );
    }).pipe(Effect.provide(BunFileSystem.layer))));
});
