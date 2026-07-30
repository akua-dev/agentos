import { describe, expect, layer } from "@effect/vitest"
import {
  AccountId,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Option, Redacted } from "effect"
import {
  AccountAdmin,
  ProviderIdentityConflictError,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionCredential,
  accountAdminLayer,
  inMemorySubscriptionAccountStoreLayer
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")

const credential = (generation: number, providerAccountId = "provider-a") =>
  SubscriptionCredential.make({
    accessToken: Redacted.make(`access-${generation}`),
    accountId,
    expiresAt: now + 3_600_000,
    generation,
    providerAccountId: Redacted.make(providerAccountId),
    refreshToken: Redacted.make(`refresh-${generation}`)
  })

const initial = SubscriptionAccountState.make({
  accountId,
  credential: credential(2),
  enabled: true,
  requiresReauthentication: true
})

const routing = inMemoryRoutingStateLayer(defaultRoutingConfig)
const store = inMemorySubscriptionAccountStoreLayer([initial]).pipe(Layer.provide(routing))
const dependencies = Layer.merge(routing, store)
const testLayer = Layer.merge(dependencies, accountAdminLayer.pipe(Layer.provide(dependencies)))

describe("account administration", () => {
  layer(testLayer)("generation and identity safety", (it) => {
    it.effect("increments generation on reauthentication and returns sanitized summaries", () =>
      Effect.gen(function* () {
        const admin = yield* AccountAdmin
        const accountStore = yield* SubscriptionAccountStore

        const summary = yield* admin.putCredential(accountId, credential(1), now)
        const stored = yield* accountStore.get(accountId)
        const summaries = yield* admin.list()

        expect(summary.generation).toBe(3)
        expect(summary.requiresReauthentication).toBe(false)
        expect(Option.isSome(stored)).toBe(true)
        if (Option.isSome(stored)) {
          expect(stored.value.credential?.generation).toBe(3)
        }
        expect(summaries).toHaveLength(1)
        const encoded = JSON.stringify(summaries)
        expect(encoded).not.toContain("access-")
        expect(encoded).not.toContain("refresh-")
        expect(encoded).not.toContain("provider-a")
      })
    )

    it.effect("rejects a device login that resolves to another provider account", () =>
      Effect.gen(function* () {
        const admin = yield* AccountAdmin
        const accountStore = yield* SubscriptionAccountStore

        const error = yield* Effect.flip(
          admin.putCredential(accountId, credential(1, "provider-b"), now + 1)
        )
        const stored = yield* accountStore.get(accountId)

        expect(error).toBeInstanceOf(ProviderIdentityConflictError)
        expect(error.message).not.toContain("provider-a")
        expect(error.message).not.toContain("provider-b")
        expect(Option.isSome(stored)).toBe(true)
        if (Option.isSome(stored)) {
          expect(stored.value.credential?.generation).toBe(3)
        }
      })
    )
  })

  layer(testLayer)("lifecycle", (it) => {
    it.effect("disables, enables, and removes an opaque account without returning secrets", () =>
      Effect.gen(function* () {
        const admin = yield* AccountAdmin

        const disabled = yield* admin.setEnabled(accountId, false, now + 2)
        expect(Option.isSome(disabled)).toBe(true)
        if (Option.isSome(disabled)) {
          expect(disabled.value.enabled).toBe(false)
        }
        const enabled = yield* admin.setEnabled(accountId, true, now + 3)
        expect(Option.isSome(enabled)).toBe(true)
        if (Option.isSome(enabled)) {
          expect(enabled.value.enabled).toBe(true)
        }
        expect(yield* admin.remove(accountId)).toBe(true)
        expect(yield* admin.list()).toEqual([])
      })
    )
  })
})
