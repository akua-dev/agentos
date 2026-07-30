import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AccountId } from "@akua-dev/codex-router-core"
import { CodexUsageParseError, decodeCodexUsage } from "../src/index.ts"

const observedAt = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")

describe("decodeCodexUsage", () => {
  it.effect("decodes snake-case windows, classifies durations, and clamps percentages", () =>
    Effect.gen(function* () {
      const usage = yield* decodeCodexUsage(
        {
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 18_000,
              reset_at: 1_800_000_000,
              used_percent: -5
            },
            secondary_window: {
              limit_window_seconds: 604_800,
              reset_at: 1_800_604_800,
              used_percent: 145
            }
          },
          credits: { balance: 12.5 }
        },
        observedAt,
        accountId
      )

      expect(usage.short.usedPercent).toBe(0)
      expect(usage.short.resetAt).toBe(1_800_000_000_000)
      expect(usage.weekly.usedPercent).toBe(100)
      expect(usage.weekly.resetAt).toBe(1_800_604_800_000)
      expect(usage.planType).toBe("plus")
      expect(usage.credits).toBe(12.5)
    })
  )

  it.effect("decodes camel-case aliases and preserves millisecond resets", () =>
    Effect.gen(function* () {
      const resetAt = 1_800_000_000_123
      const usage = yield* decodeCodexUsage(
        {
          planType: "team",
          rateLimit: {
            primary: {
              resetsAt: resetAt,
              usedPercent: 25,
              windowDurationMins: 300
            },
            secondary: {
              resetsAt: resetAt + 1,
              usedPercent: 50,
              windowDurationMins: 10_080
            }
          },
          credits: { balance: -4 }
        },
        observedAt,
        accountId
      )

      expect(usage.short.resetAt).toBe(resetAt)
      expect(usage.weekly.resetAt).toBe(resetAt + 1)
      expect(usage.planType).toBe("team")
      expect(usage.credits).toBe(0)
    })
  )

  it.effect("rejects unknown window durations and malformed response objects", () =>
    Effect.gen(function* () {
      const unknownDuration = yield* Effect.flip(
        decodeCodexUsage(
          {
            rate_limit: {
              primary_window: {
                limit_window_seconds: 60,
                used_percent: 10
              }
            }
          },
          observedAt,
          accountId
        )
      )
      const malformed = yield* Effect.flip(decodeCodexUsage("not-an-object", observedAt, accountId))

      expect(unknownDuration).toBeInstanceOf(CodexUsageParseError)
      expect(malformed).toBeInstanceOf(CodexUsageParseError)
    })
  )

  it.effect("rejects responses that do not contain both quota windows", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decodeCodexUsage(
          {
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18_000,
                used_percent: 10
              }
            }
          },
          observedAt,
          accountId
        )
      )

      expect(failure).toBeInstanceOf(CodexUsageParseError)
    })
  )

  it.effect("treats an explicit weekly-only subscription limit as unconstrained short usage", () =>
    Effect.gen(function* () {
      const resetAtSeconds = 1_805_902_970
      const usage = yield* decodeCodexUsage(
        {
          credits: { balance: "0" },
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 604_800,
              reset_after_seconds: 479_940,
              reset_at: resetAtSeconds,
              used_percent: 53
            },
            secondary_window: null
          }
        },
        observedAt,
        accountId
      )

      expect(usage.short.usedPercent).toBe(0)
      expect(usage.short.resetAt).toBeUndefined()
      expect(usage.weekly.usedPercent).toBe(53)
      expect(usage.weekly.resetAt).toBe(resetAtSeconds * 1_000)
      expect(usage.credits).toBe(0)
      expect(usage.planType).toBe("pro")
    })
  )
})
