import { afterAll, expect, it } from "@effect/vitest"
import {
  AccountId,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig
} from "@akua-dev/codex-router-core"
import {
  RefreshClaim,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionCredential
} from "@akua-dev/codex-router-codex"
import { Effect, Option, Redacted } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteSubscriptionAccountStoreLayer } from "../src/index.ts"

const testDirectory = mkdtempSync(join(tmpdir(), "codex-router-effect-sql-"))
const databasePath = join(testDirectory, "subscriptions.sqlite")
const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

const credential = (generation: number, suffix = String(generation)) =>
  SubscriptionCredential.make({
    accessToken: Redacted.make(`access-${suffix}`),
    accountId,
    expiresAt: now + 3_600_000,
    generation,
    providerAccountId: Redacted.make("provider-a"),
    refreshToken: Redacted.make(`refresh-${suffix}`)
  })

const usage = (observedAt: number) =>
  UsageSnapshot.make({
    accountId,
    observedAt,
    short: UsageWindow.make({
      resetAt: now + 18_000_000,
      usedPercent: 10
    }),
    weekly: UsageWindow.make({
      resetAt: now + 604_800_000,
      usedPercent: 20
    })
  })

const seed = (generation = 1, observedAt = now) =>
  SubscriptionAccountState.make({
    accountId,
    credential: credential(generation),
    enabled: true,
    requiresReauthentication: false,
    usage: usage(observedAt)
  })

const layer = () => sqliteSubscriptionAccountStoreLayer(databasePath, defaultRoutingConfig)

const withStore = <A, E>(effect: Effect.Effect<A, E, SubscriptionAccountStore>) =>
  effect.pipe(Effect.provide(layer()))

it.effect(
  "runs idempotent migrations and never overwrites a refreshed account during bootstrap",
  () =>
    Effect.gen(function* () {
      const inserted = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.seedIfAbsent([seed()])
        })
      )
      expect(inserted).toBe(1)

      const claim = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.claim(accountId, "credential", 1, now)
        })
      )
      expect(Option.isSome(claim)).toBe(true)
      if (Option.isNone(claim)) {
        return
      }
      const committed = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.commitCredential({
            accountId,
            claimToken: claim.value.token,
            credential: credential(2, "refreshed"),
            expectedGeneration: 1
          })
        })
      )
      expect(committed).toBe(true)

      const ignored = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.seedIfAbsent([seed()])
        })
      )
      const stored = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.get(accountId)
        })
      )
      expect(ignored).toBe(0)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) {
        const storedCredential = stored.value.credential
        expect(storedCredential?.generation).toBe(2)
        if (storedCredential === undefined) {
          return
        }
        expect(Redacted.value(storedCredential.accessToken)).toBe("access-refreshed")
        expect(stored.value.usage?.observedAt).toBe(now)
      }
    })
)

it.effect("allows exactly one cross-instance refresh claim and recovers it after expiry", () =>
  Effect.gen(function* () {
    const claims = yield* Effect.all(
      Array.from({ length: 12 }, () =>
        withStore(
          Effect.gen(function* () {
            const store = yield* SubscriptionAccountStore
            return yield* store.claim(accountId, "usage", 2, now + 1)
          })
        )
      ),
      { concurrency: "unbounded" }
    )
    expect(claims.filter(Option.isSome)).toHaveLength(1)
    const winner = claims.find(Option.isSome)
    expect(winner).toBeDefined()
    if (winner === undefined || Option.isNone(winner)) {
      return
    }
    expect(winner.value).toBeInstanceOf(RefreshClaim)

    const recovered = yield* withStore(
      Effect.gen(function* () {
        const store = yield* SubscriptionAccountStore
        return yield* store.claim(accountId, "usage", 2, winner.value.expiresAt + 1)
      })
    )
    expect(Option.isSome(recovered)).toBe(true)
    if (Option.isSome(recovered)) {
      yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          yield* store.releaseClaim(recovered.value.token)
        })
      )
    }
  })
)

it.effect("rejects stale credential and usage commits by generation", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* SubscriptionAccountStore
      const claim = yield* store.claim(accountId, "usage", 2, now + 31_000)
      expect(Option.isSome(claim)).toBe(true)
      if (Option.isNone(claim)) {
        return
      }

      const staleUsage = yield* store.commitUsage({
        accountId,
        claimToken: claim.value.token,
        expectedGeneration: 1,
        usage: usage(now + 31_000)
      })
      const staleReauth = yield* store.markRequiresReauthentication(accountId, 1)
      const stored = yield* store.get(accountId)

      expect(staleUsage).toBe(false)
      expect(staleReauth).toBe(false)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) {
        expect(stored.value.requiresReauthentication).toBe(false)
        expect(stored.value.credential?.generation).toBe(2)
      }
    })
  )
)

it.effect(
  "acquires a persisted account with its selected credential and shares routing state",
  () =>
    Effect.gen(function* () {
      const first = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.acquire({ accountIds: [accountId], now: now + 32_000 })
        })
      )
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first)) {
        return
      }
      expect(first.value.credential.generation).toBe(2)

      const summary = yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          return yield* store.summary(now + 32_000)
        })
      )
      expect(summary.activeReservations).toBe(1)

      yield* withStore(
        Effect.gen(function* () {
          const store = yield* SubscriptionAccountStore
          yield* store.release(first.value.lease.leaseToken)
        })
      )
    })
)
