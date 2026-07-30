import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  AccountBlock,
  AccountId,
  Candidate,
  NoEligibleAccountsError,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  selectAccount
} from "../src/index.ts"

const hour = 60 * 60 * 1_000
const day = 24 * hour
const now = Date.UTC(2026, 6, 30, 12)

const candidate = (
  id: string,
  options: {
    readonly shortUsed?: number
    readonly weeklyUsed?: number
    readonly weeklyResetAt?: number
    readonly observedAt?: number
    readonly requiresReauthentication?: boolean
    readonly block?: AccountBlock
    readonly activeReservations?: number
    readonly usage?: false
  } = {}
) => {
  const accountId = AccountId.make(id)
  const usage =
    options.usage === false
      ? undefined
      : UsageSnapshot.make({
          accountId,
          observedAt: options.observedAt ?? now,
          short: UsageWindow.make({
            usedPercent: options.shortUsed ?? 20,
            resetAt: now + 5 * hour
          }),
          weekly: UsageWindow.make({
            usedPercent: options.weeklyUsed ?? 40,
            resetAt: options.weeklyResetAt ?? now + 4 * day
          })
        })
  return Candidate.make({
    accountId,
    activeReservations: options.activeReservations ?? 0,
    requiresReauthentication: options.requiresReauthentication ?? false,
    ...(options.block === undefined ? {} : { block: options.block }),
    ...(usage === undefined ? {} : { usage })
  })
}

describe("selectAccount", () => {
  it.effect("keeps an eligible sticky account inside hysteresis", () =>
    Effect.gen(function* () {
      const candidateA = candidate("account-a", {
        weeklyUsed: 51
      })
      const candidateB = candidate("account-b", {
        weeklyUsed: 50
      })

      const decision = yield* selectAccount({
        candidates: [candidateA, candidateB],
        config: defaultRoutingConfig,
        currentAccountId: candidateA.accountId,
        now
      })

      expect(decision.accountId).toBe(candidateA.accountId)
      expect(decision.reason).toBe("current_account_hysteresis")
    })
  )

  it.effect("rejects unhealthy, blocked, unknown, expired, and exhausted candidates", () =>
    Effect.gen(function* () {
      const candidates = [
        candidate("reauth", { requiresReauthentication: true }),
        candidate("blocked", {
          block: AccountBlock.make({
            kind: "quota",
            retryAt: now + hour
          })
        }),
        candidate("unknown", { usage: false }),
        candidate("expired-reset", { weeklyResetAt: now }),
        candidate("short-exhausted", { shortUsed: 91 }),
        candidate("weekly-exhausted", { weeklyUsed: 98 }),
        candidate("too-old", { observedAt: now - day - 1 }),
        candidate("eligible")
      ]

      const decision = yield* selectAccount({
        candidates,
        config: defaultRoutingConfig,
        now
      })
      const rejections = new Map(
        decision.explanations.map((explanation) => [
          explanation.accountId,
          Option.getOrUndefined(explanation.rejection)
        ])
      )

      expect(decision.accountId).toBe(AccountId.make("eligible"))
      expect(rejections.get(AccountId.make("reauth"))).toBe("reauthentication_required")
      expect(rejections.get(AccountId.make("blocked"))).toBe("active_block")
      expect(rejections.get(AccountId.make("unknown"))).toBe("usage_unknown")
      expect(rejections.get(AccountId.make("expired-reset"))).toBe("weekly_reset_elapsed")
      expect(rejections.get(AccountId.make("short-exhausted"))).toBe("short_headroom")
      expect(rejections.get(AccountId.make("weekly-exhausted"))).toBe("weekly_headroom")
      expect(rejections.get(AccountId.make("too-old"))).toBe("usage_too_old")
    })
  )

  it.effect("uses stale snapshots only as a penalized fallback tier", () =>
    Effect.gen(function* () {
      const staleWinner = candidate("stale-winner", {
        observedAt: now - 2 * hour,
        weeklyUsed: 35
      })
      const staleLoser = candidate("stale-loser", {
        observedAt: now - 2 * hour,
        weeklyUsed: 40
      })
      const fresh = candidate("fresh", {
        weeklyUsed: 5
      })

      const withFresh = yield* selectAccount({
        candidates: [staleWinner, staleLoser, fresh],
        config: defaultRoutingConfig,
        now
      })
      const staleOnly = yield* selectAccount({
        candidates: [staleWinner, staleLoser],
        config: defaultRoutingConfig,
        now
      })
      const explanation = staleOnly.explanations.find(
        (item) => item.accountId === staleWinner.accountId
      )

      expect(withFresh.accountId).toBe(fresh.accountId)
      expect(staleOnly.accountId).toBe(staleWinner.accountId)
      expect(explanation).toBeDefined()
      if (explanation !== undefined) {
        expect(Option.getOrUndefined(explanation.freshness)).toBe("stale")
        expect(Option.getOrUndefined(explanation.effectiveWeeklyRemaining)).toBe(60)
      }
    })
  )

  it.effect("prioritizes weekly quota that expires soonest", () =>
    Effect.gen(function* () {
      const soon = candidate("soon", {
        weeklyUsed: 80,
        weeklyResetAt: now + hour
      })
      const later = candidate("later", {
        weeklyUsed: 20,
        weeklyResetAt: now + 100 * hour
      })

      const decision = yield* selectAccount({
        candidates: [later, soon],
        config: defaultRoutingConfig,
        now
      })

      expect(decision.accountId).toBe(soon.accountId)
    })
  )

  it.effect("breaks score ties by weekly, short, reservations, then opaque id", () =>
    Effect.gen(function* () {
      const resetA = now + 50 * hour
      const resetB = now + 25 * hour
      const lowerWeekly = candidate("weekly", {
        weeklyUsed: 50,
        weeklyResetAt: resetA
      })
      const higherWeekly = candidate("more-weekly", {
        weeklyUsed: 75,
        weeklyResetAt: resetB
      })
      const weeklyDecision = yield* selectAccount({
        candidates: [lowerWeekly, higherWeekly],
        config: defaultRoutingConfig,
        now
      })

      const lowShort = candidate("short-low", { shortUsed: 30 })
      const highShort = candidate("short-high", { shortUsed: 10 })
      const shortDecision = yield* selectAccount({
        candidates: [lowShort, highShort],
        config: defaultRoutingConfig,
        now
      })

      const reserved = candidate("reserved", { activeReservations: 2 })
      const idle = candidate("idle")
      const reservationDecision = yield* selectAccount({
        candidates: [reserved, idle],
        config: defaultRoutingConfig,
        now
      })

      const z = candidate("z-account")
      const a = candidate("a-account")
      const stableDecision = yield* selectAccount({
        candidates: [z, a],
        config: defaultRoutingConfig,
        now
      })

      expect(weeklyDecision.accountId).toBe(higherWeekly.accountId)
      expect(shortDecision.accountId).toBe(highShort.accountId)
      expect(reservationDecision.accountId).toBe(idle.accountId)
      expect(stableDecision.accountId).toBe(a.accountId)
    })
  )

  it.effect("fails with a typed error when no candidate is eligible", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        selectAccount({
          candidates: [
            candidate("reauth", { requiresReauthentication: true }),
            candidate("blocked", {
              block: AccountBlock.make({
                kind: "quota",
                retryAt: now + hour
              })
            }),
            candidate("unknown", { usage: false }),
            candidate("short-exhausted", { shortUsed: 91 }),
            candidate("weekly-exhausted", { weeklyUsed: 98 }),
            candidate("too-old", { observedAt: now - day - 1 }),
            candidate("expired-reset", { weeklyResetAt: now })
          ],
          config: defaultRoutingConfig,
          now
        })
      )

      expect(failure).toBeInstanceOf(NoEligibleAccountsError)
      expect(
        failure.explanations.map((explanation) => [
          explanation.accountId,
          Option.getOrUndefined(explanation.rejection)
        ])
      ).toEqual([
        [AccountId.make("reauth"), "reauthentication_required"],
        [AccountId.make("blocked"), "active_block"],
        [AccountId.make("unknown"), "usage_unknown"],
        [AccountId.make("short-exhausted"), "short_headroom"],
        [AccountId.make("weekly-exhausted"), "weekly_headroom"],
        [AccountId.make("too-old"), "usage_too_old"],
        [AccountId.make("expired-reset"), "weekly_reset_elapsed"]
      ])
    })
  )
})
