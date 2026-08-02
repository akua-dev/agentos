import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { defaultRoutingConfig, selectAccount } from "../src/selection.ts";
import type { Candidate } from "../src/types.ts";

const now = Date.UTC(2026, 6, 19);

function candidate(
  accountId: string,
  weeklyUsed: number,
  resetHours: number,
  shortUsed = 20,
): Candidate {
  return {
    accountId,
    label: accountId,
    needsReauth: false,
    usage: {
      accountId,
      observedAt: now,
      stale: false,
      shortWindow: { usedPercent: shortUsed, resetsAt: now + 3_600_000 },
      weeklyWindow: {
        usedPercent: weeklyUsed,
        resetsAt: now + resetHours * 3_600_000,
      },
    },
  };
}

describe("Effect quota-aware selection", () => {
  it.effect("spends healthy quota that resets sooner", () =>
    Effect.gen(function*() {
      const decision = yield* selectAccount({
        candidates: [candidate("later", 20, 120), candidate("sooner", 20, 24)],
        config: defaultRoutingConfig,
        now,
      });
      assert.strictEqual(decision.accountId, "sooner");
      assert.strictEqual(decision.reason, "best_candidate");
    }));

  it.effect("rejects low short-window headroom and old observations", () =>
    Effect.gen(function*() {
      const old = candidate("old", 10, 24);
      old.usage = old.usage === undefined
        ? undefined
        : { ...old.usage, observedAt: now - 86_400_001 };
      const decision = yield* selectAccount({
        candidates: [candidate("short", 10, 24, 95), old],
        config: defaultRoutingConfig,
        now,
      });
      assert.isUndefined(decision.accountId);
      assert.strictEqual(
        decision.candidates.some((value) =>
          value.accountId === "short" && value.rejectionCode === "short_headroom"
        ),
        true,
      );
      assert.strictEqual(
        decision.candidates.some((value) =>
          value.accountId === "old" && value.rejectionCode === "usage_too_old"
        ),
        true,
      );
    }));

  it.effect("keeps score hysteresis and deterministic tie breaking", () =>
    Effect.gen(function*() {
      const current = candidate("z-current", 20, 24);
      const other = candidate("a-other", 21, 24);
      assert.deepInclude(yield* selectAccount({
        candidates: [other, current],
        config: defaultRoutingConfig,
        currentAccountId: "z-current",
        now,
      }), {
        accountId: "z-current",
        reason: "current_account_hysteresis",
      });
      assert.strictEqual(
        (yield* selectAccount({
          candidates: [candidate("z", 20, 24), candidate("a", 20, 24)],
          config: { ...defaultRoutingConfig, scoreHysteresisRatio: 0 },
          now,
        })).accountId,
        "a",
      );
    }));
});
