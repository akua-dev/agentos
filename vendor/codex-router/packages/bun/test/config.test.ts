import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { BunConfigError, decodeBunConfig } from "../src/index.ts"

describe("decodeBunConfig", () => {
  it.effect("schema-decodes environment and redacts every credential", () =>
    Effect.gen(function* () {
      const config = yield* decodeBunConfig({
        CODEX_ROUTER_ACCOUNTS_JSON: JSON.stringify([
          {
            accessToken: "upstream-secret",
            accountId: "account-a",
            expiresAt: 1_800_003_600_000,
            observedAt: 1_800_000_000_000,
            providerAccountId: "provider-a",
            refreshToken: "refresh-secret",
            shortResetAt: 1_800_018_000_000,
            shortUsedPercent: 10,
            weeklyResetAt: 1_800_604_800_000,
            weeklyUsedPercent: 20
          }
        ]),
        CODEX_ROUTER_ADMIN_TOKEN: "admin-secret",
        CODEX_ROUTER_CLIENT_TOKEN: "client-secret",
        CODEX_ROUTER_DATABASE_PATH: "/tmp/router.sqlite",
        HOST: "127.0.0.1",
        PORT: "8788"
      })

      expect(config.port).toBe(8788)
      expect(config.hostname).toBe("127.0.0.1")
      expect(config.databasePath).toBe("/tmp/router.sqlite")
      expect(Redacted.value(config.adminToken)).toBe("admin-secret")
      expect(Redacted.value(config.clientToken)).toBe("client-secret")
      const firstAccount = config.accounts[0]
      expect(firstAccount).toBeDefined()
      if (firstAccount === undefined) {
        return
      }
      expect(Redacted.value(firstAccount.accessToken)).toBe("upstream-secret")
      expect(Redacted.value(firstAccount.refreshToken)).toBe("refresh-secret")
      expect(JSON.stringify(config)).not.toContain("client-secret")
      expect(JSON.stringify(config)).not.toContain("upstream-secret")
    })
  )

  it.effect("returns a typed redacted error for malformed config", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBunConfig({
          CODEX_ROUTER_ADMIN_TOKEN: "admin-secret",
          CODEX_ROUTER_ACCOUNTS_JSON: "not-json",
          CODEX_ROUTER_CLIENT_TOKEN: "super-secret-value",
          PORT: "70000"
        })
      )

      expect(error).toBeInstanceOf(BunConfigError)
      expect(error.message).not.toContain("not-json")
      expect(error.message).not.toContain("super-secret-value")
    })
  )

  it.effect("keeps client and administrator trust boundaries distinct", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeBunConfig({
          CODEX_ROUTER_ADMIN_TOKEN: "same-secret",
          CODEX_ROUTER_ACCOUNTS_JSON: "[]",
          CODEX_ROUTER_CLIENT_TOKEN: "same-secret"
        })
      )

      expect(error).toBeInstanceOf(BunConfigError)
      expect(error.message).not.toContain("same-secret")
    })
  )
})
