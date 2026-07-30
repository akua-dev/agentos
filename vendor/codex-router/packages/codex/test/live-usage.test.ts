import { describe, expect, it } from "@effect/vitest"
import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  SubscriptionCredential,
  UsageAuthenticationError,
  UsagePayloadError,
  UsageThrottledError,
  makeCodexUsageProbe,
  type CodexControlTransportShape
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
const credential = SubscriptionCredential.make({
  accessToken: Redacted.make("access-a"),
  accountId,
  expiresAt: now + 3_600_000,
  generation: 3,
  providerAccountId: Redacted.make("provider-a"),
  refreshToken: Redacted.make("refresh-a")
})

const transport = (response: Response, requests: Array<Request>): CodexControlTransportShape => ({
  execute: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(HttpClientRequest.fromWeb(request), response)
    })
})

describe("live Codex usage", () => {
  it.effect("fetches live usage with the selected generation and decodes both windows", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = []
      const probe = makeCodexUsageProbe({
        clock: () => now,
        transport: transport(
          Response.json({
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18_000,
                reset_at: (now + 18_000_000) / 1_000,
                used_percent: 12
              },
              secondary_window: {
                limit_window_seconds: 604_800,
                reset_at: (now + 604_800_000) / 1_000,
                used_percent: 34
              }
            }
          }),
          requests
        )
      })

      const snapshot = yield* probe.getUsage(credential)
      expect(snapshot.accountId).toBe(accountId)
      expect(snapshot.observedAt).toBe(now)
      expect(snapshot.short.usedPercent).toBe(12)
      expect(snapshot.weekly.usedPercent).toBe(34)
      const request = requests[0]
      expect(request).toBeDefined()
      if (request === undefined) {
        return
      }
      expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage")
      expect(request.headers.get("authorization")).toBe("Bearer access-a")
      expect(request.headers.get("chatgpt-account-id")).toBe("provider-a")
    })
  )

  it.effect("classifies 401 and 429 without parsing or reflecting their bodies", () =>
    Effect.gen(function* () {
      const unauthorized = makeCodexUsageProbe({
        clock: () => now,
        transport: transport(new Response("access-a rejected", { status: 401 }), [])
      })
      const throttled = makeCodexUsageProbe({
        clock: () => now,
        transport: transport(
          new Response("provider-a throttled", {
            headers: { "retry-after": "30" },
            status: 429
          }),
          []
        )
      })

      const authError = yield* Effect.flip(unauthorized.getUsage(credential))
      const throttleError = yield* Effect.flip(throttled.getUsage(credential))
      expect(authError).toBeInstanceOf(UsageAuthenticationError)
      if (!(authError instanceof UsageAuthenticationError)) {
        return
      }
      expect(authError.generation).toBe(3)
      expect(authError.message).not.toContain("access-a")
      expect(throttleError).toBeInstanceOf(UsageThrottledError)
      if (!(throttleError instanceof UsageThrottledError)) {
        return
      }
      expect(throttleError.retryAt).toBe(now + 30_000)
      expect(throttleError.message).not.toContain("provider-a")
    })
  )

  it.effect("rejects malformed success payloads with a typed redacted error", () =>
    Effect.gen(function* () {
      const probe = makeCodexUsageProbe({
        clock: () => now,
        transport: transport(Response.json({ access_token: "access-a" }), [])
      })

      const error = yield* Effect.flip(probe.getUsage(credential))
      expect(error).toBeInstanceOf(UsagePayloadError)
      expect(error.message).not.toContain("access-a")
    })
  )
})
