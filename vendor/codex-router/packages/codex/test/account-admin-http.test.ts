import { expect, layer } from "@effect/vitest"
import { defaultRoutingConfig, inMemoryRoutingStateLayer } from "@akua-dev/codex-router-core"
import { Effect, Layer } from "effect"
import {
  AccountAdmin,
  AdminAuthenticator,
  accountAdminLayer,
  inMemorySubscriptionAccountStoreLayer,
  makeAccountAdminFetch
} from "../src/index.ts"

const base64Url = (value: string): string =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")

const accessToken = (providerAccountId: string): string =>
  `${base64Url("{}")}.${base64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: providerAccountId
      }
    })
  )}.signature`

const makeLayer = (authorized: boolean) => {
  const routing = inMemoryRoutingStateLayer(defaultRoutingConfig)
  const store = inMemorySubscriptionAccountStoreLayer([]).pipe(Layer.provide(routing))
  const dependencies = Layer.mergeAll(
    routing,
    store,
    Layer.succeed(
      AdminAuthenticator,
      AdminAuthenticator.of({
        authenticate: () => Effect.succeed(authorized)
      })
    )
  )
  const admin = accountAdminLayer.pipe(Layer.provide(dependencies))
  return Layer.merge(dependencies, admin)
}

{
  let pulled = false
  layer(makeLayer(false))("admin authentication boundary", (it) => {
    it.effect("authenticates before reading a credential body", () =>
      Effect.gen(function* () {
        const fetch = yield* makeAccountAdminFetch()
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled = true
              controller.enqueue(new TextEncoder().encode("{}"))
              controller.close()
            }
          },
          { highWaterMark: 0 }
        )
        const request = new Request("https://router.invalid/admin/accounts/account-a/credential", {
          body,
          duplex: "half",
          method: "PUT"
        } as RequestInit & { readonly duplex: "half" })

        const response = yield* Effect.promise(() => fetch(request))
        expect(response.status).toBe(401)
        expect(pulled).toBe(false)
      })
    )
  })
}

layer(makeLayer(true))("admin HTTP API", (it) => {
  it.effect("stores a verified credential and returns only sanitized account state", () =>
    Effect.gen(function* () {
      const fetch = yield* makeAccountAdminFetch()
      const login = yield* Effect.promise(() =>
        fetch(
          new Request("https://router.invalid/admin/accounts/account-a/credential", {
            body: JSON.stringify({
              accessToken: accessToken("provider-a"),
              expiresAt: Date.UTC(2026, 6, 30, 13),
              refreshToken: "refresh-secret"
            }),
            method: "PUT"
          })
        )
      )
      const listed = yield* Effect.promise(() =>
        fetch(new Request("https://router.invalid/admin/accounts"))
      )
      const admin = yield* AccountAdmin
      const summaries = yield* admin.list()

      expect(login.status).toBe(200)
      expect(listed.status).toBe(200)
      expect(summaries[0]?.generation).toBe(1)
      const encoded = yield* Effect.promise(() => listed.text())
      expect(encoded).not.toContain("refresh-secret")
      expect(encoded).not.toContain("provider-a")
      expect(encoded).not.toContain("eyJ")
    })
  )
})
