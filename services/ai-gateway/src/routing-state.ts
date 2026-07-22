import { randomUUID } from "node:crypto";
import { z } from "zod";
import { selectAccount } from "./selection.ts";
import { createAtomicJsonStore, type AtomicJsonStore } from "./storage.ts";
import type { Candidate, Reservation, RoutingConfig, RoutingStateFile } from "./types.ts";

const RoutingStateSchema = z
  .object({
    version: z.literal(1),
    reservations: z.array(
      z
        .object({
          accountId: z.string().min(1),
          leaseToken: z.string().min(1),
          createdAt: z.number().int().nonnegative(),
          expiresAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    assignments: z.array(
      z
        .object({
          sessionKey: z.string().min(1),
          accountId: z.string().min(1),
          updatedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    blocks: z.array(
      z
        .object({
          accountId: z.string().min(1),
          kind: z.enum(["quota", "transient"]),
          blockedAt: z.number().int().nonnegative(),
          retryAt: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export function createRoutingStateStore(path: string): AtomicJsonStore<RoutingStateFile> {
  return createAtomicJsonStore({
    path,
    schema: RoutingStateSchema,
    createDefault: () => ({ version: 1, reservations: [], assignments: [], blocks: [] }),
  });
}

export interface AcquiredReservation extends Reservation {
  decisionReason: string;
}

export interface RoutingSummary {
  activeReservations: number;
  reservationsByAccount: Record<string, number>;
}

export function createRoutingState(store: AtomicJsonStore<RoutingStateFile>) {
  return {
    async summary(now: number): Promise<RoutingSummary> {
      const active = (await store.read()).reservations.filter((value) => value.expiresAt > now);
      const reservationsByAccount: Record<string, number> = {};
      for (const reservation of active) {
        reservationsByAccount[reservation.accountId] =
          (reservationsByAccount[reservation.accountId] ?? 0) + 1;
      }
      return { activeReservations: active.length, reservationsByAccount };
    },

    async acquire(input: {
      candidates: Candidate[];
      config: RoutingConfig;
      now: number;
      sessionKey?: string;
    }): Promise<AcquiredReservation | undefined> {
      let acquired: AcquiredReservation | undefined;
      await store.update((state) => {
        const reservations = state.reservations.filter((value) => value.expiresAt > input.now);
        const assignments = state.assignments.filter(
          (value) => value.updatedAt + input.config.assignmentTtlMs > input.now,
        );
        const currentAccountId = input.sessionKey
          ? assignments.find((value) => value.sessionKey === input.sessionKey)?.accountId
          : undefined;
        const blocks = state.blocks.filter(
          (value) => value.retryAt === undefined || value.retryAt > input.now,
        );
        const candidates = input.candidates.map((candidate) => {
          const block = blocks.find((value) => value.accountId === candidate.accountId);
          return { ...candidate, ...(block ? { block } : {}) };
        });
        const decision = selectAccount({
          candidates,
          config: input.config,
          now: input.now,
          ...(currentAccountId ? { currentAccountId } : {}),
        });
        if (!decision.accountId) return { ...state, reservations, assignments, blocks };

        const reservation: Reservation = {
          accountId: decision.accountId,
          leaseToken: randomUUID(),
          createdAt: input.now,
          expiresAt: input.now + input.config.reservationTtlMs,
        };
        acquired = { ...reservation, decisionReason: decision.reason };
        const nextAssignments = input.sessionKey
          ? [
              ...assignments.filter((value) => value.sessionKey !== input.sessionKey),
              { sessionKey: input.sessionKey, accountId: decision.accountId, updatedAt: input.now },
            ]
          : assignments;
        return {
          ...state,
          reservations: [...reservations, reservation],
          assignments: nextAssignments,
          blocks,
        };
      });
      return acquired;
    },

    async renew(leaseToken: string, now: number, ttlMs = 120_000): Promise<boolean> {
      let renewed = false;
      await store.update((state) => ({
        ...state,
        reservations: state.reservations
          .filter((value) => value.expiresAt > now)
          .map((value) => {
            if (value.leaseToken !== leaseToken) return value;
            renewed = true;
            return { ...value, expiresAt: now + ttlMs };
          }),
      }));
      return renewed;
    },

    async release(leaseToken: string): Promise<boolean> {
      let released = false;
      await store.update((state) => ({
        ...state,
        reservations: state.reservations.filter((value) => {
          if (value.leaseToken !== leaseToken) return true;
          released = true;
          return false;
        }),
      }));
      return released;
    },

    async block(block: RoutingStateFile["blocks"][number]): Promise<void> {
      await store.update((state) => ({
        ...state,
        blocks: [...state.blocks.filter((value) => value.accountId !== block.accountId), block],
      }));
    },
  };
}
