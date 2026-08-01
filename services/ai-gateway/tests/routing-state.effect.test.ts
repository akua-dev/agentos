import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
} from "effect";

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
) {
  return Effect.scoped(Effect.gen(function*() {
    const routing = yield* AIRoutingState;
    return yield* operation(routing);
  }).pipe(Effect.provide(makeEffectAIRoutingStateLayer(path, config))));
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
            const acquired = yield* routing.acquire({
              candidates,
              now,
              sessionKey: "session-1",
            });
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
            assert.strictEqual(
              yield* routing.release(acquired.leaseToken),
              true,
            );
            return acquired;
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
          }),
      );
      assert.strictEqual(sticky?.accountId, "a");
    }).pipe(Effect.provide(BunFileSystem.layer))));

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
            assert.isDefined(yield* routing.acquire({ candidates, now }));
            yield* routing.acquire({ candidates, now: now + 11 });
            assert.strictEqual(
              (yield* routing.summary(now + 11)).activeReservations,
              1,
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
            const first = yield* routing.acquire({ candidates: tied, now });
            const second = yield* routing.acquire({
              candidates: tied,
              now: now + 1,
            });
            assert.strictEqual(first?.accountId, "a");
            assert.strictEqual(first?.decisionReason, "best_candidate");
            assert.strictEqual(second?.accountId, "b");
            assert.strictEqual(second?.decisionReason, "best_candidate");
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
            }));
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
