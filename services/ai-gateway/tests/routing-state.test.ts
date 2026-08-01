import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoutingState } from "../src/routing-state.ts";
import { defaultRoutingConfig } from "../src/selection.ts";
import type { Candidate } from "../src/types.ts";

const now = Date.UTC(2026, 6, 19);
const candidates: Candidate[] = [
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

describe("canonical durable routing state adapter", () => {
  test("selects and reserves atomically, persists explicit stickiness, renews and releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const path = join(root, "routing.sqlite");
    const routing = await createRoutingState(path, defaultRoutingConfig);

    const first = await routing.acquire({
      candidates,
      now,
      sessionKey: "session-1",
    });
    expect(first).toMatchObject({ accountId: "a" });
    expect(first?.leaseToken).toBeString();
    expect(await routing.summary(now + 1)).toEqual({
      activeReservations: 1,
      reservationsByAccount: { a: 1 },
      lastSelection: {
        observedAt: now,
        reason: "best_candidate",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            accountId: "a",
            eligible: true,
          }),
        ]),
      },
    });

    expect(await routing.renew(first!.leaseToken, now + 30_000)).toBe(true);
    expect(await routing.release(first!.leaseToken)).toBe(true);
    await routing.close();

    const reopened = await createRoutingState(path, defaultRoutingConfig);
    try {
      const sticky = await reopened.acquire({
        candidates,
        now: now + 30_001,
        sessionKey: "session-1",
      });
      expect(sticky?.accountId).toBe("a");
    } finally {
      await reopened.close();
    }
  });

  test("does not invent stickiness without an explicit session key and removes expired leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const routing = await createRoutingState(join(root, "routing.sqlite"), {
      ...defaultRoutingConfig,
      reservationTtlMs: 10,
    });
    try {
      const acquired = await routing.acquire({
        candidates,
        now,
      });
      expect(acquired).toBeDefined();

      await routing.acquire({
        candidates,
        now: now + 11,
      });
      expect(await routing.summary(now + 11)).toMatchObject({
        activeReservations: 1,
      });
    } finally {
      await routing.close();
    }
  });

  test("uses codex-router reservation pressure as the deterministic tie break", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const routing = await createRoutingState(
      join(root, "routing.sqlite"),
      defaultRoutingConfig,
    );
    const tied = candidates.map((value) => ({
      ...value,
      usage: {
        ...value.usage!,
        weeklyWindow: {
          usedPercent: 20,
          resetsAt: now + 24 * 3_600_000,
        },
      },
    }));

    try {
      expect(
        await routing.acquire({
          candidates: tied,
          now,
        }),
      ).toMatchObject({
        accountId: "a",
        decisionReason: "best_candidate",
      });
      expect(
        await routing.acquire({
          candidates: tied,
          now: now + 1,
        }),
      ).toMatchObject({
        accountId: "b",
        decisionReason: "best_candidate",
      });
    } finally {
      await routing.close();
    }
  });

  test("retains bounded codex-router rejection explanations for protected status", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const routing = await createRoutingState(
      join(root, "routing.sqlite"),
      defaultRoutingConfig,
    );

    try {
      expect(
        await routing.acquire({
          candidates: [
            {
              accountId: "reauth",
              label: "Reauth",
              needsReauth: true,
            },
          ],
          now,
        }),
      ).toBeUndefined();
      expect(await routing.summary(now)).toMatchObject({
        lastSelection: {
          observedAt: now,
          reason: "no_eligible_accounts",
          candidates: [
            {
              accountId: "reauth",
              eligible: false,
              freshness: "unknown",
              rejectionCode: "reauthentication_required",
            },
          ],
        },
      });
    } finally {
      await routing.close();
    }
  });

  test("evaluates current eligibility without acquiring or mutating a lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const routing = await createRoutingState(
      join(root, "routing.sqlite"),
      defaultRoutingConfig,
    );

    try {
      expect(await routing.evaluate({ candidates, now })).toMatchObject({
        accountId: "a",
        reason: "best_candidate",
      });
      expect(await routing.summary(now)).toEqual({
        activeReservations: 0,
        reservationsByAccount: {},
      });
    } finally {
      await routing.close();
    }
  });
});
