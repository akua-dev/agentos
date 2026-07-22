import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createRoutingState, createRoutingStateStore } from "../src/routing-state.ts";
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
      weeklyWindow: { usedPercent: 20, resetsAt: now + 24 * 3_600_000 },
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
      weeklyWindow: { usedPercent: 20, resetsAt: now + 48 * 3_600_000 },
    },
  },
];

describe("durable routing state", () => {
  test("selects and reserves atomically, persists explicit stickiness, renews and releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const store = createRoutingStateStore(join(root, "routing.json"));
    const routing = createRoutingState(store);

    const first = await routing.acquire({
      candidates,
      config: defaultRoutingConfig,
      now,
      sessionKey: "session-1",
    });
    expect(first).toMatchObject({ accountId: "a" });
    expect(first?.leaseToken).toBeString();
    expect(await routing.summary(now + 1)).toEqual({
      activeReservations: 1,
      reservationsByAccount: { a: 1 },
    });

    const sticky = await routing.acquire({
      candidates,
      config: defaultRoutingConfig,
      now: now + 1,
      sessionKey: "session-1",
    });
    expect(sticky?.accountId).toBe("a");

    expect(await routing.renew(first!.leaseToken, now + 30_000)).toBe(true);
    expect(await routing.release(first!.leaseToken)).toBe(true);
    expect((await store.read()).assignments).toEqual([
      expect.objectContaining({ sessionKey: "session-1", accountId: "a" }),
    ]);
  });

  test("does not invent stickiness without an explicit session key and removes expired leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-routing-"));
    const store = createRoutingStateStore(join(root, "routing.json"));
    const routing = createRoutingState(store);
    const acquired = await routing.acquire({
      candidates,
      config: { ...defaultRoutingConfig, reservationTtlMs: 10 },
      now,
    });
    expect(acquired).toBeDefined();
    expect((await store.read()).assignments).toEqual([]);

    await routing.acquire({
      candidates,
      config: { ...defaultRoutingConfig, reservationTtlMs: 10 },
      now: now + 11,
    });
    expect((await store.read()).reservations).toHaveLength(1);
  });
});
