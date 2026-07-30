import {
  AccountBlock,
  AccountId,
  AccountRoutingSummary,
  Candidate,
  LeaseToken,
  Reservation,
  RouteLease,
  RoutingState,
  RoutingStateError,
  RoutingSummary,
  SessionKey,
  defaultRoutingConfig,
  selectAccount,
  type AccountId as AccountIdType,
  type RoutingConfig,
  type RoutingStateShape,
  type SessionKey as SessionKeyType
} from "@akua-dev/codex-router-core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Crypto, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { subscriptionMigrations } from "./migrations.ts"

const AssignmentRow = Schema.Struct({
  account_id: Schema.String,
  session_key: Schema.String,
  updated_at: Schema.Number
})

const ReservationRow = Schema.Struct({
  account_id: Schema.String,
  created_at: Schema.Number,
  expires_at: Schema.Number,
  lease_token: Schema.String,
  session_key: Schema.NullOr(Schema.String)
})

const CountRow = Schema.Struct({
  account_id: Schema.String,
  count: Schema.Number
})

const TotalsRow = Schema.Struct({
  assignments: Schema.Number,
  reservations: Schema.Number
})

const HealthRow = Schema.Struct({
  account_id: Schema.String,
  block_kind: Schema.NullOr(Schema.Literals(["quota", "transient"])),
  requires_reauth: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number)
})
type HealthRow = typeof HealthRow.Type

const decodeAssignments = Schema.decodeUnknownEffect(Schema.Array(AssignmentRow))
const decodeReservation = Schema.decodeUnknownSync(ReservationRow)
const decodeCounts = Schema.decodeUnknownEffect(Schema.Array(CountRow))
const decodeTotals = Schema.decodeUnknownEffect(Schema.Array(TotalsRow))
const decodeHealthRows = Schema.decodeUnknownEffect(Schema.Array(HealthRow))

const routingError = () =>
  new RoutingStateError({
    message: "The SQLite routing-state operation failed"
  })

const mapRoutingError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(routingError))

export const sqliteConnectionPragmas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA busy_timeout = 5000`.withoutTransform
  yield* sql`PRAGMA foreign_keys = ON`.withoutTransform
})

const rowBlock = (row: HealthRow | undefined): AccountBlock | undefined => {
  if (row?.block_kind === null || row?.block_kind === undefined) {
    return undefined
  }
  return AccountBlock.make({
    kind: row.block_kind,
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at })
  })
}

const overlayCandidate = (
  candidate: Candidate,
  counts: ReadonlyMap<AccountIdType, number>,
  health: ReadonlyMap<AccountIdType, HealthRow>
): Candidate => {
  const row = health.get(candidate.accountId)
  const block = rowBlock(row) ?? candidate.block
  return Candidate.make({
    accountId: candidate.accountId,
    activeReservations: candidate.activeReservations + (counts.get(candidate.accountId) ?? 0),
    requiresReauthentication: candidate.requiresReauthentication || row?.requires_reauth === 1,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
    ...(block === undefined ? {} : { block })
  })
}

export const makeSqliteRoutingState = Effect.fn("makeSqliteRoutingState")(function* (
  config: RoutingConfig = defaultRoutingConfig
) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto

  const cleanup = Effect.fn("SqliteRoutingState.cleanup")(function* (now: number) {
    yield* sql`DELETE FROM reservations WHERE expires_at <= ${now}`
    yield* sql`
        DELETE FROM assignments
        WHERE updated_at + ${config.assignmentTtlMs} <= ${now}
      `
    yield* sql`
        UPDATE blocks
        SET block_kind = NULL, retry_at = NULL
        WHERE retry_at IS NOT NULL AND retry_at <= ${now}
      `
    yield* sql`
        DELETE FROM blocks
        WHERE block_kind IS NULL AND requires_reauth = 0
      `
  })

  const activeReservationCounts = Effect.gen(function* () {
    const rows = yield* sql<typeof CountRow.Type>`
        SELECT account_id, COUNT(*) AS count
        FROM reservations
        GROUP BY account_id
      `.pipe(Effect.flatMap(decodeCounts))
    return new Map(rows.map((row) => [AccountId.make(row.account_id), row.count] as const))
  })

  const healthMap = Effect.gen(function* () {
    const rows = yield* sql<typeof HealthRow.Type>`
        SELECT account_id, block_kind, retry_at, requires_reauth
        FROM blocks
      `.pipe(Effect.flatMap(decodeHealthRows))
    return new Map(rows.map((row) => [AccountId.make(row.account_id), row] as const))
  })

  const currentAssignment = Effect.fn("SqliteRoutingState.currentAssignment")(function* (
    sessionKey: SessionKeyType | undefined
  ) {
    if (sessionKey === undefined) {
      return Option.none<AccountIdType>()
    }
    const rows = yield* sql<typeof AssignmentRow.Type>`
          SELECT session_key, account_id, updated_at
          FROM assignments
          WHERE session_key = ${sessionKey}
        `.pipe(Effect.flatMap(decodeAssignments))
    return Option.map(Option.fromNullishOr(rows[0]), (row) => AccountId.make(row.account_id))
  })

  const acquire: RoutingStateShape["acquire"] = (input) =>
    mapRoutingError(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* cleanup(input.now)
          const counts = yield* activeReservationCounts
          const health = yield* healthMap
          const current = yield* currentAssignment(input.sessionKey)
          const decision = yield* Effect.option(
            selectAccount({
              candidates: input.candidates.map((candidate) =>
                overlayCandidate(candidate, counts, health)
              ),
              config,
              now: input.now,
              ...(Option.isNone(current) ? {} : { currentAccountId: current.value })
            })
          )
          if (Option.isNone(decision)) {
            return Option.none<RouteLease>()
          }
          const leaseToken = LeaseToken.make(yield* crypto.randomUUIDv4)
          const expiresAt = input.now + config.leaseTtlMs
          yield* sql`
              INSERT INTO reservations(
                lease_token, account_id, session_key, created_at, expires_at
              ) VALUES (
                ${leaseToken}, ${decision.value.accountId},
                ${input.sessionKey ?? null}, ${input.now}, ${expiresAt}
              )
            `
          if (input.sessionKey !== undefined) {
            yield* sql`
                INSERT INTO assignments(session_key, account_id, updated_at)
                VALUES (
                  ${input.sessionKey}, ${decision.value.accountId}, ${input.now}
                )
                ON CONFLICT(session_key) DO UPDATE SET
                  account_id = excluded.account_id,
                  updated_at = excluded.updated_at
              `
          }
          return Option.some(
            RouteLease.make({
              accountId: decision.value.accountId,
              expiresAt,
              leaseToken,
              sessionKey:
                input.sessionKey === undefined
                  ? Option.none<SessionKeyType>()
                  : Option.some(input.sessionKey)
            })
          )
        })
      )
    )

  const renew: RoutingStateShape["renew"] = (leaseToken, now) =>
    mapRoutingError(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* cleanup(now)
          const rows = yield* sql<{ readonly lease_token: string }>`
              UPDATE reservations
              SET expires_at = ${now + config.leaseTtlMs}
              WHERE lease_token = ${leaseToken} AND expires_at > ${now}
              RETURNING lease_token
            `
          return rows.length === 1
        })
      )
    )

  const release: RoutingStateShape["release"] = (leaseToken) =>
    mapRoutingError(sql`DELETE FROM reservations WHERE lease_token = ${leaseToken}`).pipe(
      Effect.asVoid
    )

  const recordResponse: RoutingStateShape["recordResponse"] = (accountId, classification, now) =>
    mapRoutingError(
      sql.withTransaction(
        classification.kind === "success"
          ? sql`DELETE FROM blocks WHERE account_id = ${accountId}`.pipe(Effect.asVoid)
          : classification.kind === "reauth"
            ? sql`
                  INSERT INTO blocks(
                    account_id, block_kind, retry_at, requires_reauth
                  ) VALUES (${accountId}, NULL, NULL, 1)
                  ON CONFLICT(account_id) DO UPDATE SET
                    block_kind = NULL,
                    retry_at = NULL,
                    requires_reauth = 1
                `.pipe(Effect.asVoid)
            : classification.kind === "quota" || classification.kind === "transient"
              ? sql`
                    INSERT INTO blocks(
                      account_id, block_kind, retry_at, requires_reauth
                    ) VALUES (
                      ${accountId},
                      ${classification.kind},
                      ${Option.getOrElse(classification.retryAt, () =>
                        classification.kind === "transient" ? now + 30_000 : null
                      )},
                      0
                    )
                    ON CONFLICT(account_id) DO UPDATE SET
                      block_kind = excluded.block_kind,
                      retry_at = excluded.retry_at,
                      requires_reauth = MAX(
                        blocks.requires_reauth,
                        excluded.requires_reauth
                      )
                  `.pipe(Effect.asVoid)
              : Effect.void
      )
    ).pipe(Effect.asVoid)

  const summary: RoutingStateShape["summary"] = (now) =>
    mapRoutingError(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* cleanup(now)
          const counts = yield* activeReservationCounts
          const health = yield* healthMap
          const assignmentRows = yield* sql<typeof CountRow.Type>`
              SELECT account_id, COUNT(*) AS count
              FROM assignments
              GROUP BY account_id
            `.pipe(Effect.flatMap(decodeCounts))
          const totals = yield* sql<typeof TotalsRow.Type>`
              SELECT
                (SELECT COUNT(*) FROM assignments) AS assignments,
                (SELECT COUNT(*) FROM reservations) AS reservations
            `.pipe(Effect.flatMap(decodeTotals))
          const accountIds = new Set<AccountIdType>([...counts.keys(), ...health.keys()])
          for (const row of assignmentRows) {
            accountIds.add(AccountId.make(row.account_id))
          }
          const accounts = [...accountIds]
            .sort((left, right) => left.localeCompare(right))
            .map((accountId) => {
              const row = health.get(accountId)
              return AccountRoutingSummary.make({
                accountId,
                activeReservations: counts.get(accountId) ?? 0,
                blockKind:
                  row?.block_kind === null || row?.block_kind === undefined
                    ? Option.none()
                    : Option.some(row.block_kind),
                requiresReauthentication: row?.requires_reauth === 1
              })
            })
          return RoutingSummary.make({
            accounts,
            activeReservations: totals[0]?.reservations ?? 0,
            assignments: totals[0]?.assignments ?? 0
          })
        })
      )
    )

  return RoutingState.of({
    acquire,
    recordResponse,
    release,
    renew,
    summary
  })
})

export const sqliteRoutingStateFromSqlLayer = (config: RoutingConfig = defaultRoutingConfig) =>
  Layer.effect(RoutingState, makeSqliteRoutingState(config))

const sqliteInfrastructureLayer = (databasePath: string) => {
  const sql = SqliteClient.layer({
    filename: databasePath,
    spanAttributes: {
      "db.namespace": "codex-router",
      "service.name": "codex-router-bun-routing"
    }
  })
  const migrations = SqliteMigrator.layer({
    loader: subscriptionMigrations
  }).pipe(Layer.provide(sql))
  const pragmas = Layer.effectDiscard(sqliteConnectionPragmas).pipe(Layer.provide(sql))
  return Layer.mergeAll(sql, migrations, pragmas, BunCrypto.layer)
}

export const sqliteRoutingStateLayer = (
  databasePath: string,
  config: RoutingConfig = defaultRoutingConfig
) => {
  const infrastructure = sqliteInfrastructureLayer(databasePath)
  const routing = sqliteRoutingStateFromSqlLayer(config).pipe(Layer.provide(infrastructure))
  return Layer.merge(infrastructure, routing)
}

export interface SqliteRoutingStateHandle {
  readonly close: Effect.Effect<void>
  readonly state: RoutingStateShape
}

export const openSqliteRoutingState = Effect.fn("openSqliteRoutingState")(function* (
  databasePath: string,
  config: RoutingConfig = defaultRoutingConfig
) {
  const runtime = ManagedRuntime.make(sqliteRoutingStateLayer(databasePath, config))
  const state = yield* Effect.tryPromise({
    try: () => runtime.runPromise(RoutingState),
    catch: routingError
  })
  return {
    close: Effect.promise(runtime.dispose),
    state
  } satisfies SqliteRoutingStateHandle
})

export const decodeReservationRow = (input: unknown): Reservation => {
  const row = decodeReservation(input)
  return Reservation.make({
    accountId: AccountId.make(row.account_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    leaseToken: LeaseToken.make(row.lease_token),
    sessionKey:
      row.session_key === null
        ? Option.none<SessionKeyType>()
        : Option.some(SessionKey.make(row.session_key))
  })
}
