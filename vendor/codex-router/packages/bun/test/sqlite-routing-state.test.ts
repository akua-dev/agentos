import { afterAll, expect, it } from "@effect/vitest"
import {
  AccountId,
  Candidate,
  SessionKey,
  UsageSnapshot,
  UsageWindow,
  classifyUpstreamResponse,
  defaultRoutingConfig
} from "@akua-dev/codex-router-core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqliteRoutingState, sqliteRoutingStateLayer } from "../src/index.ts"

const testDirectory = mkdtempSync(join(tmpdir(), "codex-router-sqlite-"))
const databasePath = join(testDirectory, "routing.sqlite")
const now = Date.UTC(2026, 6, 30, 12)
const hour = 60 * 60 * 1_000

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

const candidate = (id: string, observedAt = now) => {
  const accountId = AccountId.make(id)
  return Candidate.make({
    accountId,
    activeReservations: 0,
    requiresReauthentication: false,
    usage: UsageSnapshot.make({
      accountId,
      observedAt,
      short: UsageWindow.make({
        resetAt: observedAt + hour,
        usedPercent: 10
      }),
      weekly: UsageWindow.make({
        resetAt: observedAt + 7 * 24 * hour,
        usedPercent: 10
      })
    })
  })
}

const candidates = [candidate("account-a"), candidate("account-b")]
const openRoutingState = () =>
  openSqliteRoutingState(databasePath, defaultRoutingConfig).pipe(Effect.provide(BunCrypto.layer))

it.effect("uses the official Effect SQL migration chain", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const migrations = yield* sql<{
      readonly migration_id: number
      readonly name: string
    }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      ORDER BY migration_id
    `

    expect(migrations).toEqual([
      { migration_id: 1, name: "subscription_accounts" },
      { migration_id: 2, name: "routing_state" }
    ])
  }).pipe(Effect.provide(sqliteRoutingStateLayer(databasePath)))
)

it.effect("shares transactionally visible leases and assignments across instances", () =>
  Effect.gen(function* () {
    const first = yield* Effect.acquireRelease(openRoutingState(), (handle) => handle.close)
    const second = yield* Effect.acquireRelease(openRoutingState(), (handle) => handle.close)

    const leases = yield* Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first.state : second.state).acquire({
          candidates,
          now,
          sessionKey: SessionKey.make(`session-${index}`)
        })
      ),
      { concurrency: "unbounded" }
    )
    const summary = yield* second.state.summary(now)

    expect(leases.filter(Option.isSome)).toHaveLength(20)
    expect(summary.activeReservations).toBe(20)
    expect(summary.assignments).toBe(20)
  })
)

it.effect("persists sticky assignments and cleans expired reservations atomically", () =>
  Effect.gen(function* () {
    const handle = yield* Effect.acquireRelease(openRoutingState(), (opened) => opened.close)
    const sessionKey = SessionKey.make("sticky-session")
    const first = yield* handle.state.acquire({
      candidates,
      now: now + 1,
      sessionKey
    })
    expect(Option.isSome(first)).toBe(true)
    if (Option.isNone(first)) {
      return
    }
    yield* handle.state.release(first.value.leaseToken)

    const sticky = yield* handle.state.acquire({
      candidates: [...candidates].reverse(),
      now: now + 2,
      sessionKey
    })
    expect(Option.getOrUndefined(sticky)?.accountId).toBe(first.value.accountId)

    const afterLeaseExpiry = yield* handle.state.summary(
      now + 2 + defaultRoutingConfig.leaseTtlMs + 1
    )
    expect(afterLeaseExpiry.activeReservations).toBe(0)
  })
)

it.effect("shares replacement blocks and reauthentication state without secrets", () =>
  Effect.gen(function* () {
    const first = yield* Effect.acquireRelease(openRoutingState(), (handle) => handle.close)
    const second = yield* Effect.acquireRelease(openRoutingState(), (handle) => handle.close)
    const firstAccountId = candidates[0]?.accountId
    const secondAccountId = candidates[1]?.accountId
    expect(firstAccountId).toBeDefined()
    expect(secondAccountId).toBeDefined()
    if (firstAccountId === undefined || secondAccountId === undefined) {
      return
    }

    yield* first.state.recordResponse(
      firstAccountId,
      classifyUpstreamResponse(429, new Headers({ "retry-after": "60" }), now),
      now
    )
    yield* first.state.recordResponse(
      firstAccountId,
      classifyUpstreamResponse(503, new Headers(), now + 1),
      now + 1
    )
    yield* first.state.recordResponse(
      firstAccountId,
      classifyUpstreamResponse(401, new Headers(), now + 2),
      now + 2
    )
    const lease = yield* second.state.acquire({
      candidates,
      now: now + 3
    })
    const summary = yield* second.state.summary(now + 3)

    expect(Option.getOrUndefined(lease)?.accountId).toBe(secondAccountId)
    const firstAccount = summary.accounts.find((account) => account.accountId === firstAccountId)
    expect(firstAccount).toMatchObject({
      requiresReauthentication: true
    })
    expect(Option.isNone(firstAccount?.blockKind ?? Option.none())).toBe(true)
    expect(JSON.stringify(summary)).not.toContain("selected-secret")
  })
)
