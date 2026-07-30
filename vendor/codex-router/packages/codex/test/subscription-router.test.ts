import { describe, expect, layer } from "@effect/vitest"
import {
  AccountId,
  UsageSnapshot,
  UsageWindow,
  classifyUpstreamResponse,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Option, Redacted } from "effect"
import {
  OAuthClient,
  OAuthTransportError,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionCredential,
  SubscriptionRouter,
  UsageProbe,
  UsageTransportError,
  inMemorySubscriptionAccountStoreLayer,
  subscriptionRouterLayer
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")

const credential = (generation: number, expiresAt: number) =>
  SubscriptionCredential.make({
    accessToken: Redacted.make(`access-${generation}`),
    accountId,
    expiresAt,
    generation,
    providerAccountId: Redacted.make("provider-a"),
    refreshToken: Redacted.make(`refresh-${generation}`)
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

const account = (
  storedCredential: SubscriptionCredential,
  storedUsage?: UsageSnapshot
): SubscriptionAccountState =>
  SubscriptionAccountState.make({
    accountId,
    credential: storedCredential,
    enabled: true,
    requiresReauthentication: false,
    ...(storedUsage === undefined ? {} : { usage: storedUsage })
  })

interface Probe {
  oauthCalls: number
  usageCalls: number
}

const makeLayer = (
  probe: Probe,
  initial: ReadonlyArray<SubscriptionAccountState>,
  options: {
    readonly oauthFailure?: boolean
    readonly usageFailure?: boolean
  } = {}
) => {
  const routing = inMemoryRoutingStateLayer(defaultRoutingConfig)
  const store = inMemorySubscriptionAccountStoreLayer(initial).pipe(Layer.provide(routing))
  const dependencies = Layer.mergeAll(
    routing,
    store,
    Layer.succeed(
      OAuthClient,
      OAuthClient.of({
        pollDeviceAuthorization: () =>
          Effect.fail(new OAuthTransportError({ message: "not used" })),
        refresh: (source) =>
          Effect.gen(function* () {
            probe.oauthCalls += 1
            if (options.oauthFailure === true) {
              return yield* new OAuthTransportError({ message: "temporary refresh failure" })
            }
            return credential(source.generation + 1, now + 3_600_000)
          }),
        startDeviceAuthorization: () =>
          Effect.fail(new OAuthTransportError({ message: "not used" }))
      })
    ),
    Layer.succeed(
      UsageProbe,
      UsageProbe.of({
        getUsage: () =>
          Effect.gen(function* () {
            probe.usageCalls += 1
            if (options.usageFailure === true) {
              return yield* new UsageTransportError({ message: "temporary usage failure" })
            }
            return usage(now)
          })
      })
    )
  )
  return Layer.merge(dependencies, subscriptionRouterLayer.pipe(Layer.provide(dependencies)))
}

describe("subscription router", () => {
  const probe: Probe = { oauthCalls: 0, usageCalls: 0 }
  layer(makeLayer(probe, [account(credential(1, now + 60_000), usage(now - 61_000))]))(
    "single flight",
    (it) => {
      it.effect(
        "shares one early refresh and one stale usage probe across concurrent acquisitions",
        () =>
          Effect.gen(function* () {
            const router = yield* SubscriptionRouter
            const grants = yield* Effect.all(
              Array.from({ length: 10 }, () => router.acquire({ now })),
              { concurrency: "unbounded" }
            )

            expect(probe.oauthCalls).toBe(1)
            expect(probe.usageCalls).toBe(1)
            for (const grant of grants) {
              expect(Option.isSome(grant)).toBe(true)
              if (Option.isSome(grant)) {
                expect(grant.value.credential.generation).toBe(2)
              }
            }
          })
      )
    }
  )

  const generationProbe: Probe = { oauthCalls: 0, usageCalls: 0 }
  layer(makeLayer(generationProbe, [account(credential(2, now + 3_600_000), usage(now))]))(
    "generation safety",
    (it) => {
      it.effect("ignores a late 401 produced by an older credential generation", () =>
        Effect.gen(function* () {
          const router = yield* SubscriptionRouter
          const store = yield* SubscriptionAccountStore
          const classification = classifyUpstreamResponse(401, new Headers(), now)

          yield* router.recordResponse(accountId, 1, classification, now)
          const stored = yield* store.get(accountId)

          expect(Option.isSome(stored)).toBe(true)
          if (Option.isSome(stored)) {
            expect(stored.value.requiresReauthentication).toBe(false)
            expect(stored.value.credential?.generation).toBe(2)
          }
        })
      )
    }
  )

  const staleProbe: Probe = { oauthCalls: 0, usageCalls: 0 }
  layer(
    makeLayer(staleProbe, [account(credential(1, now + 3_600_000), usage(now - 300_000))], {
      usageFailure: true
    })
  )("stale fallback", (it) => {
    it.effect("retains a prior snapshot timestamp when a live probe fails", () =>
      Effect.gen(function* () {
        const router = yield* SubscriptionRouter
        const store = yield* SubscriptionAccountStore
        const grant = yield* router.acquire({ now })
        const stored = yield* store.get(accountId)

        expect(Option.isSome(grant)).toBe(true)
        expect(staleProbe.usageCalls).toBe(1)
        expect(Option.isSome(stored)).toBe(true)
        if (Option.isSome(stored)) {
          expect(stored.value.usage?.observedAt).toBe(now - 300_000)
        }
      })
    )
  })

  const unknownProbe: Probe = { oauthCalls: 0, usageCalls: 0 }
  layer(
    makeLayer(unknownProbe, [account(credential(1, now + 3_600_000))], {
      usageFailure: true
    })
  )("unknown usage", (it) => {
    it.effect("keeps an account ineligible when its first live probe fails", () =>
      Effect.gen(function* () {
        const router = yield* SubscriptionRouter
        const grant = yield* router.acquire({ now })

        expect(Option.isNone(grant)).toBe(true)
        expect(unknownProbe.usageCalls).toBe(1)
      })
    )
  })

  const maintenanceProbe: Probe = { oauthCalls: 0, usageCalls: 0 }
  layer(makeLayer(maintenanceProbe, [account(credential(1, now + 60_000), usage(now - 61_000))]))(
    "maintenance",
    (it) => {
      it.effect("proactively refreshes due credentials and usage without acquiring a lease", () =>
        Effect.gen(function* () {
          const router = yield* SubscriptionRouter
          const store = yield* SubscriptionAccountStore

          const result = yield* router.maintain(now)
          const stored = yield* store.get(accountId)

          expect(result.visited).toBe(1)
          expect(result.ready).toBe(1)
          expect(maintenanceProbe.oauthCalls).toBe(1)
          expect(maintenanceProbe.usageCalls).toBe(1)
          expect(Option.isSome(stored)).toBe(true)
          if (Option.isSome(stored)) {
            expect(stored.value.credential?.generation).toBe(2)
            expect(stored.value.usage?.observedAt).toBe(now)
          }
        })
      )
    }
  )
})
