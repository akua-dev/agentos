import { expect, layer } from "@effect/vitest"
import {
  AccountId,
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "@akua-dev/codex-router-core"
import {
  AccountAdmin,
  AdminAuthenticator,
  AccountDirectory,
  ClientAuthenticator,
  GatewayTelemetry,
  SubscriptionCredential,
  configuredSubscriptionRouterLayer,
  UpstreamTransport
} from "@akua-dev/codex-router-codex"
import { Effect, Layer, Redacted } from "effect"
import { makeBunFetch } from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
const candidate = Candidate.make({
  accountId,
  activeReservations: 0,
  requiresReauthentication: false,
  usage: UsageSnapshot.make({
    accountId,
    observedAt: now,
    short: UsageWindow.make({
      resetAt: now + 60 * 60 * 1_000,
      usedPercent: 5
    }),
    weekly: UsageWindow.make({
      resetAt: now + 7 * 24 * 60 * 60 * 1_000,
      usedPercent: 5
    })
  })
})

const dependencies = Layer.mergeAll(
  inMemoryRoutingStateLayer(defaultRoutingConfig),
  Layer.succeed(
    AdminAuthenticator,
    AdminAuthenticator.of({
      authenticate: (request) =>
        Effect.succeed(request.headers.get("x-ai-router-admin-token") === "admin-secret")
    })
  ),
  Layer.succeed(
    AccountAdmin,
    AccountAdmin.of({
      list: () => Effect.succeed([]),
      putCredential: () => Effect.die("not used"),
      remove: () => Effect.die("not used"),
      setEnabled: () => Effect.die("not used")
    })
  ),
  Layer.succeed(
    ClientAuthenticator,
    ClientAuthenticator.of({
      authenticate: (request) =>
        Effect.succeed(request.headers.get("x-ai-router-token") === "client-secret")
    })
  ),
  Layer.succeed(
    AccountDirectory,
    AccountDirectory.of({
      candidates: Effect.succeed([candidate]),
      credential: () =>
        Effect.succeed(
          SubscriptionCredential.make({
            accessToken: Redacted.make("upstream-secret"),
            accountId,
            expiresAt: Number.MAX_SAFE_INTEGER,
            generation: 1,
            providerAccountId: Redacted.make("provider-a"),
            refreshToken: Redacted.make("refresh-secret")
          })
        )
    })
  ),
  Layer.succeed(
    UpstreamTransport,
    UpstreamTransport.of({
      execute: () =>
        Effect.succeed(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: done\n\n"))
                controller.close()
              }
            }),
            {
              headers: { "content-type": "text/event-stream" }
            }
          )
        )
    })
  ),
  Layer.succeed(
    GatewayTelemetry,
    GatewayTelemetry.of({
      bookkeepingFailure: () => Effect.void,
      decision: () => Effect.void
    })
  )
)
const testLayer = Layer.merge(
  dependencies,
  configuredSubscriptionRouterLayer.pipe(Layer.provide(dependencies))
)

layer(testLayer)("Bun HTTP composition", (it) => {
  it.effect("serves health, authenticated status, and the shared streaming router", () =>
    Effect.gen(function* () {
      const fetch = yield* makeBunFetch()
      const health = yield* Effect.promise(() => fetch(new Request("http://localhost/healthz")))
      const unauthorized = yield* Effect.promise(() =>
        fetch(new Request("http://localhost/status"))
      )
      const status = yield* Effect.promise(() =>
        fetch(
          new Request("http://localhost/status", {
            headers: { "x-ai-router-token": "client-secret" }
          })
        )
      )
      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://localhost/responses", {
            body: "{}",
            headers: { "x-ai-router-token": "client-secret" },
            method: "POST"
          })
        )
      )
      const adminUnauthorized = yield* Effect.promise(() =>
        fetch(new Request("http://localhost/admin/accounts"))
      )
      const admin = yield* Effect.promise(() =>
        fetch(
          new Request("http://localhost/admin/accounts", {
            headers: { "x-ai-router-admin-token": "admin-secret" }
          })
        )
      )

      expect(health.status).toBe(200)
      expect(yield* Effect.promise(() => health.json())).toEqual({ status: "ok" })
      expect(unauthorized.status).toBe(401)
      expect(status.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => status.json()))).not.toContain("secret")
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe("data: done\n\n")
      expect(adminUnauthorized.status).toBe(401)
      expect(admin.status).toBe(200)
    })
  )
})
