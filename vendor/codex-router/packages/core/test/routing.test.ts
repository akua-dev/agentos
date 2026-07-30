import { expect, layer } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  AccountId,
  Candidate,
  RoutingState,
  SessionKey,
  UsageSnapshot,
  UsageWindow,
  classifyUpstreamResponse,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "../src/index.ts"

const hour = 60 * 60 * 1_000
const now = Date.UTC(2026, 6, 30, 12)

const candidate = (id: string, observedAt = now) => {
  const accountId = AccountId.make(id)
  return Candidate.make({
    accountId,
    activeReservations: 0,
    requiresReauthentication: false,
    usage: UsageSnapshot.make({
      accountId,
      observedAt,
      short: UsageWindow.make({
        resetAt: observedAt + hour,
        usedPercent: 10
      }),
      weekly: UsageWindow.make({
        resetAt: observedAt + 7 * 24 * hour,
        usedPercent: 10
      })
    })
  })
}

const candidates = [candidate("account-a"), candidate("account-b")]
const routingStateLayer = inMemoryRoutingStateLayer(defaultRoutingConfig)

layer(routingStateLayer)("concurrent acquisition", (it) => {
  it.effect("serializes concurrent acquisitions and counts every active lease", () =>
    Effect.gen(function* () {
      const state = yield* RoutingState
      const leases = yield* Effect.all(
        Array.from({ length: 20 }, (_, index) =>
          state.acquire({
            candidates,
            now,
            sessionKey: SessionKey.make(`session-${index}`)
          })
        ),
        { concurrency: "unbounded" }
      )
      const summary = yield* state.summary(now)

      expect(leases.filter(Option.isSome)).toHaveLength(20)
      expect(summary.activeReservations).toBe(20)
      expect(summary.assignments).toBe(20)
    })
  )
})

layer(routingStateLayer)("session assignments", (it) => {
  it.effect("uses assignments only for explicit session keys and expires them by TTL", () =>
    Effect.gen(function* () {
      const state = yield* RoutingState
      const sessionKey = SessionKey.make("sticky")
      const first = yield* state.acquire({
        candidates,
        now,
        sessionKey
      })
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first)) {
        return
      }

      yield* state.release(first.value.leaseToken)
      const sticky = yield* state.acquire({
        candidates: [...candidates].reverse(),
        now: now + 1,
        sessionKey
      })
      expect(Option.getOrUndefined(sticky)?.accountId).toBe(first.value.accountId)

      const anonymous = yield* state.acquire({
        candidates,
        now: now + 2
      })
      expect(Option.isSome(anonymous)).toBe(true)

      const afterExpiry = yield* state.acquire({
        candidates: [
          candidate("account-a", now + defaultRoutingConfig.assignmentTtlMs + 1),
          candidate("account-b", now + defaultRoutingConfig.assignmentTtlMs + 1)
        ],
        now: now + defaultRoutingConfig.assignmentTtlMs + 1,
        sessionKey
      })
      const summary = yield* state.summary(now + defaultRoutingConfig.assignmentTtlMs + 1)

      expect(Option.isSome(afterExpiry)).toBe(true)
      expect(summary.assignments).toBe(1)
    })
  )
})

layer(routingStateLayer)("lease lifecycle", (it) => {
  it.effect("renews, releases, and cleans expired leases", () =>
    Effect.gen(function* () {
      const state = yield* RoutingState
      const acquired = yield* state.acquire({ candidates, now })
      expect(Option.isSome(acquired)).toBe(true)
      if (Option.isNone(acquired)) {
        return
      }

      expect(yield* state.renew(acquired.value.leaseToken, now + 1_000)).toBe(true)
      expect(
        (yield* state.summary(now + defaultRoutingConfig.leaseTtlMs + 500)).activeReservations
      ).toBe(1)
      yield* state.release(acquired.value.leaseToken)
      expect((yield* state.summary(now + 2_000)).activeReservations).toBe(0)

      const expiring = yield* state.acquire({ candidates, now: now + 3_000 })
      expect(Option.isSome(expiring)).toBe(true)
      expect(
        (yield* state.summary(now + 3_000 + defaultRoutingConfig.leaseTtlMs + 1)).activeReservations
      ).toBe(0)
    })
  )
})

layer(routingStateLayer)("response bookkeeping", (it) => {
  it.effect("replaces quota blocks and exposes only sanitized routing state", () =>
    Effect.gen(function* () {
      const state = yield* RoutingState
      const accountId = candidates[0]?.accountId
      expect(accountId).toBeDefined()
      if (accountId === undefined) {
        return
      }

      yield* state.recordResponse(
        accountId,
        classifyUpstreamResponse(429, new Headers({ "retry-after": "60" }), now),
        now
      )
      let summary = yield* state.summary(now)
      let accountSummary = summary.accounts.find((account) => account.accountId === accountId)
      expect(accountSummary).toBeDefined()
      if (accountSummary === undefined) {
        return
      }
      expect(Option.getOrUndefined(accountSummary.blockKind)).toBe("quota")

      yield* state.recordResponse(
        accountId,
        classifyUpstreamResponse(503, new Headers(), now + 1),
        now + 1
      )
      summary = yield* state.summary(now + 1)
      accountSummary = summary.accounts.find((account) => account.accountId === accountId)
      expect(accountSummary).toBeDefined()
      if (accountSummary === undefined) {
        return
      }
      expect(Option.getOrUndefined(accountSummary.blockKind)).toBe("transient")
      expect(JSON.stringify(summary)).not.toContain("token")
      expect(JSON.stringify(summary)).not.toContain("authorization")
    })
  )
})

layer(routingStateLayer)("reauthentication", (it) => {
  it.effect("marks 401 accounts for reauthentication during subsequent selection", () =>
    Effect.gen(function* () {
      const state = yield* RoutingState
      const firstId = candidates[0]?.accountId
      const secondId = candidates[1]?.accountId
      expect(firstId).toBeDefined()
      expect(secondId).toBeDefined()
      if (firstId === undefined || secondId === undefined) {
        return
      }

      yield* state.recordResponse(firstId, classifyUpstreamResponse(401, new Headers(), now), now)
      const lease = yield* state.acquire({ candidates, now: now + 1 })

      expect(Option.getOrUndefined(lease)?.accountId).toBe(secondId)
    })
  )
})
