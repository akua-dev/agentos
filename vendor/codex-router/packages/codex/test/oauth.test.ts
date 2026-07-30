import { describe, expect, it } from "@effect/vitest"
import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted, Result } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  DeviceAuthorization,
  DeviceAuthorizationPending,
  DeviceAuthorizationReady,
  InvalidCodexTokenError,
  OAuthInvalidGrantError,
  ProviderIdentityChangedError,
  SubscriptionCredential,
  extractProviderAccountId,
  makeOpenAiOAuthClient,
  type CodexControlTransportShape
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")

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

const makeTransport = (
  responses: ReadonlyArray<Response>,
  requests: Array<Request>
): CodexControlTransportShape => {
  let index = 0
  return {
    execute: (request) =>
      Effect.sync(() => {
        requests.push(request)
        const response = responses[index]
        index += 1
        return HttpClientResponse.fromWeb(
          HttpClientRequest.fromWeb(request),
          response ?? new Response(null, { status: 500 })
        )
      })
  }
}

describe("OpenAI Codex OAuth", () => {
  it.effect("extracts and redacts the provider identity from a JWT", () =>
    Effect.gen(function* () {
      const identity = yield* extractProviderAccountId(accessToken("provider-a"))

      expect(Redacted.value(identity)).toBe("provider-a")
      expect(JSON.stringify(identity)).not.toContain("provider-a")
      const error = yield* Effect.flip(extractProviderAccountId("not-a-token"))
      expect(error.message).not.toContain("not-a-token")
      const malformedEncoding = yield* Effect.flip(extractProviderAccountId("a.b*.c"))
      expect(malformedEncoding).toBeInstanceOf(InvalidCodexTokenError)
      expect(malformedEncoding.message).not.toContain("b*")
    })
  )

  it.effect("starts device authorization and returns pending without leaking device identity", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = []
      const client = makeOpenAiOAuthClient({
        clock: () => now,
        transport: makeTransport(
          [
            Response.json({
              device_auth_id: "device-auth-secret",
              interval: "5",
              user_code: "ABCD-EFGH"
            }),
            new Response(null, { status: 403 })
          ],
          requests
        )
      })

      const device = yield* client.startDeviceAuthorization()
      expect(device).toBeInstanceOf(DeviceAuthorization)
      expect(device.userCode).toBe("ABCD-EFGH")
      expect(device.verificationUri).toBe("https://auth.openai.com/codex/device")
      expect(device.intervalSeconds).toBe(5)
      expect(JSON.stringify(device)).not.toContain("device-auth-secret")

      const result = yield* client.pollDeviceAuthorization(device)
      expect(result).toBeInstanceOf(DeviceAuthorizationPending)
      if (!(result instanceof DeviceAuthorizationPending)) {
        return
      }
      expect(result.retryAfterSeconds).toBe(5)
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/accounts/deviceauth/usercode",
        "/api/accounts/deviceauth/token"
      ])
    })
  )

  it.effect("honors device authorization pending and slow-down responses", () =>
    Effect.gen(function* () {
      const client = makeOpenAiOAuthClient({
        clock: () => now,
        transport: makeTransport(
          [
            Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 400 }),
            Response.json({ error: "slow_down" }, { status: 400 })
          ],
          []
        )
      })
      const device = DeviceAuthorization.make({
        deviceAuthId: Redacted.make("device-a"),
        expiresAt: now + 900_000,
        intervalSeconds: 5,
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device"
      })

      const pending = yield* client.pollDeviceAuthorization(device)
      const slowed = yield* client.pollDeviceAuthorization(device)
      expect(pending).toBeInstanceOf(DeviceAuthorizationPending)
      expect(slowed).toBeInstanceOf(DeviceAuthorizationPending)
      if (
        !(pending instanceof DeviceAuthorizationPending) ||
        !(slowed instanceof DeviceAuthorizationPending)
      ) {
        return
      }
      expect(pending.retryAfterSeconds).toBe(5)
      expect(slowed.retryAfterSeconds).toBe(10)
    })
  )

  it.effect("exchanges a completed device flow into a generation-one credential", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = []
      const client = makeOpenAiOAuthClient({
        clock: () => now,
        transport: makeTransport(
          [
            Response.json({
              authorization_code: "authorization-code",
              code_verifier: "code-verifier"
            }),
            Response.json({
              access_token: accessToken("provider-a"),
              expires_in: 3_600,
              refresh_token: "refresh-a"
            })
          ],
          requests
        )
      })
      const device = DeviceAuthorization.make({
        deviceAuthId: Redacted.make("device-a"),
        expiresAt: now + 900_000,
        intervalSeconds: 5,
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device"
      })

      const result = yield* client.pollDeviceAuthorization(device, accountId)
      expect(result).toBeInstanceOf(DeviceAuthorizationReady)
      if (!(result instanceof DeviceAuthorizationReady)) {
        return
      }
      expect(result.credential).toBeInstanceOf(SubscriptionCredential)
      expect(result.credential.accountId).toBe(accountId)
      expect(result.credential.generation).toBe(1)
      expect(result.credential.expiresAt).toBe(now + 3_600_000)
      expect(Redacted.value(result.credential.refreshToken)).toBe("refresh-a")
      expect(Redacted.value(result.credential.providerAccountId)).toBe("provider-a")

      const exchange = requests[1]
      expect(exchange).toBeDefined()
      if (exchange === undefined) {
        return
      }
      expect(yield* Effect.promise(() => exchange.text())).toContain(
        "redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback"
      )
    })
  )

  it.effect(
    "refreshes early credentials, preserves an omitted refresh token, and increments generation",
    () =>
      Effect.gen(function* () {
        const requests: Array<Request> = []
        const client = makeOpenAiOAuthClient({
          clock: () => now,
          transport: makeTransport(
            [
              Response.json({
                access_token: accessToken("provider-a"),
                expires_in: 7_200
              })
            ],
            requests
          )
        })
        const source = SubscriptionCredential.make({
          accessToken: Redacted.make(accessToken("provider-a")),
          accountId,
          expiresAt: now + 60_000,
          generation: 7,
          providerAccountId: Redacted.make("provider-a"),
          refreshToken: Redacted.make("refresh-a")
        })

        const refreshed = yield* client.refresh(source)
        expect(refreshed.generation).toBe(8)
        expect(refreshed.expiresAt).toBe(now + 7_200_000)
        expect(Redacted.value(refreshed.refreshToken)).toBe("refresh-a")
        const body = requests[0]
        expect(body).toBeDefined()
        if (body !== undefined) {
          expect(yield* Effect.promise(() => body.text())).toContain("grant_type=refresh_token")
        }
      })
  )

  it.effect("fails closed when refresh changes provider identity", () =>
    Effect.gen(function* () {
      const client = makeOpenAiOAuthClient({
        clock: () => now,
        transport: makeTransport(
          [
            Response.json({
              access_token: accessToken("provider-b"),
              expires_in: 3_600,
              refresh_token: "refresh-b"
            })
          ],
          []
        )
      })
      const source = SubscriptionCredential.make({
        accessToken: Redacted.make(accessToken("provider-a")),
        accountId,
        expiresAt: now,
        generation: 2,
        providerAccountId: Redacted.make("provider-a"),
        refreshToken: Redacted.make("refresh-a")
      })

      const error = yield* Effect.flip(client.refresh(source))
      expect(error).toBeInstanceOf(ProviderIdentityChangedError)
      expect(error.message).not.toContain("provider-a")
      expect(error.message).not.toContain("provider-b")
    })
  )

  it.effect("classifies invalid grants without reflecting provider payloads", () =>
    Effect.gen(function* () {
      const client = makeOpenAiOAuthClient({
        clock: () => now,
        transport: makeTransport(
          [
            Response.json(
              { error: "invalid_grant", error_description: "refresh-a was revoked" },
              { status: 400 }
            )
          ],
          []
        )
      })
      const source = SubscriptionCredential.make({
        accessToken: Redacted.make(accessToken("provider-a")),
        accountId,
        expiresAt: now,
        generation: 1,
        providerAccountId: Redacted.make("provider-a"),
        refreshToken: Redacted.make("refresh-a")
      })

      const result = yield* Effect.result(client.refresh(source))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(OAuthInvalidGrantError)
        expect(result.failure.message).not.toContain("refresh-a")
      }
    })
  )
})
