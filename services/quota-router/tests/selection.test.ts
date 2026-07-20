import { describe, expect, test } from "bun:test";
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
      weeklyWindow: { usedPercent: weeklyUsed, resetsAt: now + resetHours * 3_600_000 },
    },
  };
}

describe("quota-aware selection", () => {
  test("spends healthy quota that resets sooner", () => {
    const decision = selectAccount({
      candidates: [candidate("later", 20, 120), candidate("sooner", 20, 24)],
      config: defaultRoutingConfig,
      now,
    });
    expect(decision.accountId).toBe("sooner");
    expect(decision.reason).toBe("highest_weekly_urgency");
  });

  test("rejects low short-window headroom and observations older than 24 hours", () => {
    const old = candidate("old", 10, 24);
    old.usage = { ...old.usage!, observedAt: now - 86_400_001 };
    const decision = selectAccount({
      candidates: [candidate("short", 10, 24, 95), old],
      config: defaultRoutingConfig,
      now,
    });
    expect(decision.accountId).toBeUndefined();
    expect(decision.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: "short", rejectionCode: "short_headroom" }),
        expect.objectContaining({ accountId: "old", rejectionCode: "usage_too_old" }),
      ]),
    );
  });

  test("keeps a current session inside score hysteresis and breaks ties deterministically", () => {
    const current = candidate("z-current", 20, 24);
    const other = candidate("a-other", 21, 24);
    expect(
      selectAccount({
        candidates: [other, current],
        config: defaultRoutingConfig,
        currentAccountId: "z-current",
        now,
      }),
    ).toMatchObject({ accountId: "z-current", reason: "current_account_hysteresis" });

    expect(
      selectAccount({
        candidates: [candidate("z", 20, 24), candidate("a", 20, 24)],
        config: { ...defaultRoutingConfig, scoreHysteresisRatio: 0 },
        now,
      }).accountId,
    ).toBe("a");
  });
});
