import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import {
  AccountId,
  Candidate,
  RoutingState,
  UsageSnapshot,
  defaultRoutingConfig,
  type AccountId as AccountIdType,
  type RoutingConfig
} from "@akua-dev/codex-router-core"
import {
  RefreshClaim,
  RefreshClaimToken,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionAccountStoreError,
  SubscriptionCredential,
  SubscriptionRouteGrant,
  type SubscriptionAccountStoreShape
} from "@akua-dev/codex-router-codex"
import { Clock, Crypto, Effect, Layer, Option, Redacted, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { subscriptionMigrations } from "./migrations.ts"
import { sqliteConnectionPragmas, sqliteRoutingStateFromSqlLayer } from "./sqlite-routing-state.ts"

const AccountRow = Schema.Struct({
  account_id: Schema.String,
  credential_expires_at: Schema.NullOr(Schema.Number),
  credential_generation: Schema.NullOr(Schema.Number),
  credential_json: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  requires_reauth: Schema.Number
})

const UsageRow = Schema.Struct({
  account_id: Schema.String,
  observed_at: Schema.Number,
  payload_json: Schema.String
})

const ClaimRow = Schema.Struct({
  account_id: Schema.String,
  claim_token: Schema.String,
  expires_at: Schema.Number,
  generation: Schema.Number,
  operation: Schema.Literals(["credential", "usage"])
})

const CredentialPayload = Schema.Struct({
  accessToken: Schema.String,
  providerAccountId: Schema.String,
  refreshToken: Schema.String
})

const decodeAccountRows = Schema.decodeUnknownEffect(Schema.Array(AccountRow))
const decodeUsageRows = Schema.decodeUnknownEffect(Schema.Array(UsageRow))
const decodeClaimRows = Schema.decodeUnknownEffect(Schema.Array(ClaimRow))
const decodeCredentialPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialPayload))
const decodeUsagePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageSnapshot))

const storeFailure = () =>
  new SubscriptionAccountStoreError({
    message: "The SQLite subscription account operation failed"
  })

const mapStoreFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(storeFailure))

const encodeCredential = (credential: SubscriptionCredential): string =>
  JSON.stringify({
    accessToken: Redacted.value(credential.accessToken),
    providerAccountId: Redacted.value(credential.providerAccountId),
    refreshToken: Redacted.value(credential.refreshToken)
  })

const encodeUsage = (usage: UsageSnapshot): string =>
  JSON.stringify({
    accountId: usage.accountId,
    observedAt: usage.observedAt,
    short: {
      resetAt: usage.short.resetAt,
      usedPercent: usage.short.usedPercent
    },
    weekly: {
      resetAt: usage.weekly.resetAt,
      usedPercent: usage.weekly.usedPercent
    },
    ...(usage.credits === undefined ? {} : { credits: usage.credits }),
    ...(usage.planType === undefined ? {} : { planType: usage.planType }),
    ...(usage.stale === undefined ? {} : { stale: usage.stale })
  })

const decodeCredential = Effect.fn("SqliteSubscriptionAccountStore.decodeCredential")(function* (
  row: typeof AccountRow.Type
) {
  if (
    row.credential_expires_at === null ||
    row.credential_generation === null ||
    row.credential_json === null
  ) {
    return Option.none<SubscriptionCredential>()
  }
  const payload = yield* decodeCredentialPayload(row.credential_json).pipe(
    Effect.mapError(storeFailure)
  )
  return Option.some(
    SubscriptionCredential.make({
      accessToken: Redacted.make(payload.accessToken),
      accountId: AccountId.make(row.account_id),
      expiresAt: row.credential_expires_at,
      generation: row.credential_generation,
      providerAccountId: Redacted.make(payload.providerAccountId),
      refreshToken: Redacted.make(payload.refreshToken)
    })
  )
})

const accountStates = Effect.fn("SqliteSubscriptionAccountStore.accountStates")(function* (
  sql: SqlClient.SqlClient
) {
  const accountRows = yield* mapStoreFailure(
    sql<typeof AccountRow.Type>`
      SELECT account_id, enabled, requires_reauth, credential_generation,
             credential_expires_at, credential_json
      FROM subscription_accounts
      ORDER BY account_id
    `
  ).pipe(Effect.flatMap(decodeAccountRows), Effect.mapError(storeFailure))
  const usageRows = yield* mapStoreFailure(
    sql<typeof UsageRow.Type>`
      SELECT account_id, observed_at, payload_json
      FROM usage_snapshots
    `
  ).pipe(Effect.flatMap(decodeUsageRows), Effect.mapError(storeFailure))
  const usageByAccount = new Map<AccountIdType, UsageSnapshot>()
  for (const row of usageRows) {
    const snapshot = yield* decodeUsagePayload(row.payload_json).pipe(Effect.mapError(storeFailure))
    usageByAccount.set(AccountId.make(row.account_id), snapshot)
  }
  return yield* Effect.forEach(accountRows, (row) =>
    decodeCredential(row).pipe(
      Effect.map((credential) => {
        const accountId = AccountId.make(row.account_id)
        const storedUsage = usageByAccount.get(accountId)
        return SubscriptionAccountState.make({
          accountId,
          enabled: row.enabled === 1,
          requiresReauthentication: row.requires_reauth === 1,
          ...(Option.isNone(credential) ? {} : { credential: credential.value }),
          ...(storedUsage === undefined ? {} : { usage: storedUsage })
        })
      })
    )
  )
})

const getAccount = Effect.fn("SqliteSubscriptionAccountStore.getAccount")(function* (
  sql: SqlClient.SqlClient,
  accountId: AccountIdType
) {
  const accounts = yield* accountStates(sql)
  return Option.fromNullishOr(accounts.find((account) => account.accountId === accountId))
})

const claimFromRows = (rows: ReadonlyArray<typeof ClaimRow.Type>): Option.Option<RefreshClaim> => {
  const row = rows[0]
  return row === undefined
    ? Option.none()
    : Option.some(
        RefreshClaim.make({
          accountId: AccountId.make(row.account_id),
          expiresAt: row.expires_at,
          generation: row.generation,
          operation: row.operation,
          token: RefreshClaimToken.make(row.claim_token)
        })
      )
}

export const makeSqliteSubscriptionAccountStore = Effect.fn("makeSqliteSubscriptionAccountStore")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const routing = yield* RoutingState
    const crypto = yield* Crypto.Crypto

    const seedIfAbsent: SubscriptionAccountStoreShape["seedIfAbsent"] = Effect.fn(
      "SqliteSubscriptionAccountStore.seedIfAbsent"
    )((accounts) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const updatedAt = yield* Clock.currentTimeMillis
            let inserted = 0
            for (const account of accounts) {
              const existing = yield* sql<{ account_id: string }>`
              SELECT account_id
              FROM subscription_accounts
              WHERE account_id = ${account.accountId}
            `
              if (existing.length > 0) {
                continue
              }
              const credential = account.credential
              yield* sql`
              INSERT INTO subscription_accounts(
                account_id, enabled, requires_reauth, credential_generation,
                credential_expires_at, credential_json, updated_at
              ) VALUES (
                ${account.accountId},
                ${account.enabled ? 1 : 0},
                ${account.requiresReauthentication ? 1 : 0},
                ${credential?.generation ?? null},
                ${credential?.expiresAt ?? null},
                ${credential === undefined ? null : encodeCredential(credential)},
                ${updatedAt}
              )
            `
              if (account.usage !== undefined) {
                yield* sql`
                INSERT OR IGNORE INTO usage_snapshots(account_id, observed_at, payload_json)
                VALUES (
                  ${account.accountId},
                  ${account.usage.observedAt},
                  ${encodeUsage(account.usage)}
                )
              `
              }
              inserted += 1
            }
            return inserted
          })
        )
      )
    )

    const list: SubscriptionAccountStoreShape["list"] = accountStates(sql)

    const get: SubscriptionAccountStoreShape["get"] = Effect.fn(
      "SqliteSubscriptionAccountStore.get"
    )((accountId) => getAccount(sql, accountId))

    const claim: SubscriptionAccountStoreShape["claim"] = Effect.fn(
      "SqliteSubscriptionAccountStore.claim"
    )((accountId, operation, generation, now) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM refresh_claims WHERE expires_at <= ${now}`
            const accounts = yield* sql<{
              credential_generation: number | null
              requires_reauth: number
            }>`
            SELECT credential_generation, requires_reauth
            FROM subscription_accounts
            WHERE account_id = ${accountId}
          `
            const account = accounts[0]
            if (account?.credential_generation !== generation || account.requires_reauth === 1) {
              return Option.none<RefreshClaim>()
            }
            const token = RefreshClaimToken.make(
              yield* crypto.randomUUIDv4.pipe(Effect.mapError(storeFailure))
            )
            yield* sql`
            INSERT OR IGNORE INTO refresh_claims(
              account_id, operation, claim_token, generation, expires_at
            ) VALUES (
              ${accountId}, ${operation}, ${token}, ${generation}, ${now + 30_000}
            )
          `
            const rows = yield* sql<typeof ClaimRow.Type>`
            SELECT account_id, operation, claim_token, generation, expires_at
            FROM refresh_claims
            WHERE claim_token = ${token}
          `.pipe(Effect.flatMap(decodeClaimRows), Effect.mapError(storeFailure))
            return claimFromRows(rows)
          })
        )
      )
    )

    const releaseClaim: SubscriptionAccountStoreShape["releaseClaim"] = Effect.fn(
      "SqliteSubscriptionAccountStore.releaseClaim"
    )((claimToken) =>
      mapStoreFailure(sql`DELETE FROM refresh_claims WHERE claim_token = ${claimToken}`).pipe(
        Effect.asVoid
      )
    )

    const commitCredential: SubscriptionAccountStoreShape["commitCredential"] = Effect.fn(
      "SqliteSubscriptionAccountStore.commitCredential"
    )((commit) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const updatedAt = yield* Clock.currentTimeMillis
            const claims = yield* sql<typeof ClaimRow.Type>`
            SELECT account_id, operation, claim_token, generation, expires_at
            FROM refresh_claims
            WHERE claim_token = ${commit.claimToken}
          `.pipe(Effect.flatMap(decodeClaimRows), Effect.mapError(storeFailure))
            const claim = claims[0]
            const accounts = yield* sql<{ credential_generation: number | null }>`
            SELECT credential_generation
            FROM subscription_accounts
            WHERE account_id = ${commit.accountId}
          `
            if (
              claim?.account_id !== commit.accountId ||
              claim.operation !== "credential" ||
              claim.generation !== commit.expectedGeneration ||
              accounts[0]?.credential_generation !== commit.expectedGeneration ||
              commit.credential.generation !== commit.expectedGeneration + 1
            ) {
              return false
            }
            yield* sql`
            UPDATE subscription_accounts
            SET credential_generation = ${commit.credential.generation},
                credential_expires_at = ${commit.credential.expiresAt},
                credential_json = ${encodeCredential(commit.credential)},
                requires_reauth = 0,
                updated_at = ${updatedAt}
            WHERE account_id = ${commit.accountId}
              AND credential_generation = ${commit.expectedGeneration}
          `
            yield* sql`DELETE FROM refresh_claims WHERE claim_token = ${commit.claimToken}`
            return true
          })
        )
      )
    )

    const commitUsage: SubscriptionAccountStoreShape["commitUsage"] = Effect.fn(
      "SqliteSubscriptionAccountStore.commitUsage"
    )((commit) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const claims = yield* sql<typeof ClaimRow.Type>`
            SELECT account_id, operation, claim_token, generation, expires_at
            FROM refresh_claims
            WHERE claim_token = ${commit.claimToken}
          `.pipe(Effect.flatMap(decodeClaimRows), Effect.mapError(storeFailure))
            const claim = claims[0]
            const accounts = yield* sql<{ credential_generation: number | null }>`
            SELECT credential_generation
            FROM subscription_accounts
            WHERE account_id = ${commit.accountId}
          `
            if (
              claim?.account_id !== commit.accountId ||
              claim.operation !== "usage" ||
              claim.generation !== commit.expectedGeneration ||
              accounts[0]?.credential_generation !== commit.expectedGeneration ||
              commit.usage.accountId !== commit.accountId
            ) {
              return false
            }
            yield* sql`
            INSERT INTO usage_snapshots(account_id, observed_at, payload_json)
            VALUES (
              ${commit.accountId},
              ${commit.usage.observedAt},
              ${encodeUsage(commit.usage)}
            )
            ON CONFLICT(account_id) DO UPDATE SET
              observed_at = excluded.observed_at,
              payload_json = excluded.payload_json
          `
            yield* sql`DELETE FROM refresh_claims WHERE claim_token = ${commit.claimToken}`
            return true
          })
        )
      )
    )

    const markRequiresReauthentication: SubscriptionAccountStoreShape["markRequiresReauthentication"] =
      Effect.fn("SqliteSubscriptionAccountStore.markRequiresReauthentication")(
        (accountId, generation) =>
          mapStoreFailure(
            sql.withTransaction(
              Effect.gen(function* () {
                const updatedAt = yield* Clock.currentTimeMillis
                const accounts = yield* sql<{
                  credential_generation: number | null
                }>`
                SELECT credential_generation
                FROM subscription_accounts
                WHERE account_id = ${accountId}
              `
                if (accounts[0]?.credential_generation !== generation) {
                  return false
                }
                yield* sql`
                UPDATE subscription_accounts
                SET requires_reauth = 1, updated_at = ${updatedAt}
                WHERE account_id = ${accountId}
                  AND credential_generation = ${generation}
              `
                return true
              })
            )
          )
      )

    const replaceCredential: SubscriptionAccountStoreShape["replaceCredential"] = Effect.fn(
      "SqliteSubscriptionAccountStore.replaceCredential"
    )((replacement) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* getAccount(sql, replacement.accountId)
            if (
              Option.isSome(existing) &&
              existing.value.credential !== undefined &&
              Redacted.value(existing.value.credential.providerAccountId) !==
                Redacted.value(replacement.credential.providerAccountId)
            ) {
              return Option.none<SubscriptionAccountState>()
            }
            const generation =
              (Option.isSome(existing) ? (existing.value.credential?.generation ?? 0) : 0) + 1
            const credential = SubscriptionCredential.make({
              accessToken: replacement.credential.accessToken,
              accountId: replacement.accountId,
              expiresAt: replacement.credential.expiresAt,
              generation,
              providerAccountId: replacement.credential.providerAccountId,
              refreshToken: replacement.credential.refreshToken
            })
            const enabled = Option.isSome(existing) ? existing.value.enabled : true
            yield* sql`
            INSERT INTO subscription_accounts(
              account_id, enabled, requires_reauth, credential_generation,
              credential_expires_at, credential_json, updated_at
            ) VALUES (
              ${replacement.accountId},
              ${enabled ? 1 : 0},
              0,
              ${credential.generation},
              ${credential.expiresAt},
              ${encodeCredential(credential)},
              ${replacement.now}
            )
            ON CONFLICT(account_id) DO UPDATE SET
              credential_generation = excluded.credential_generation,
              credential_expires_at = excluded.credential_expires_at,
              credential_json = excluded.credential_json,
              requires_reauth = 0,
              updated_at = excluded.updated_at
          `
            yield* sql`DELETE FROM usage_snapshots WHERE account_id = ${replacement.accountId}`
            yield* sql`DELETE FROM refresh_claims WHERE account_id = ${replacement.accountId}`
            yield* sql`DELETE FROM blocks WHERE account_id = ${replacement.accountId}`
            return yield* getAccount(sql, replacement.accountId)
          })
        )
      )
    )

    const setEnabled: SubscriptionAccountStoreShape["setEnabled"] = Effect.fn(
      "SqliteSubscriptionAccountStore.setEnabled"
    )((accountId, enabled, now) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* getAccount(sql, accountId)
            if (Option.isNone(existing)) {
              return Option.none<SubscriptionAccountState>()
            }
            yield* sql`
            UPDATE subscription_accounts
            SET enabled = ${enabled ? 1 : 0}, updated_at = ${now}
            WHERE account_id = ${accountId}
          `
            return yield* getAccount(sql, accountId)
          })
        )
      )
    )

    const remove: SubscriptionAccountStoreShape["remove"] = Effect.fn(
      "SqliteSubscriptionAccountStore.remove"
    )((accountId) =>
      mapStoreFailure(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ account_id: string }>`
            SELECT account_id
            FROM subscription_accounts
            WHERE account_id = ${accountId}
          `
            if (existing.length === 0) {
              return false
            }
            yield* sql`DELETE FROM refresh_claims WHERE account_id = ${accountId}`
            yield* sql`DELETE FROM usage_snapshots WHERE account_id = ${accountId}`
            yield* sql`DELETE FROM assignments WHERE account_id = ${accountId}`
            yield* sql`DELETE FROM reservations WHERE account_id = ${accountId}`
            yield* sql`DELETE FROM blocks WHERE account_id = ${accountId}`
            yield* sql`DELETE FROM subscription_accounts WHERE account_id = ${accountId}`
            return true
          })
        )
      )
    )

    const acquire: SubscriptionAccountStoreShape["acquire"] = Effect.fn(
      "SqliteSubscriptionAccountStore.acquire"
    )(function* (input) {
      const accounts = yield* accountStates(sql)
      const allowed = new Set(input.accountIds)
      const candidates = accounts
        .filter(
          (account) =>
            allowed.has(account.accountId) &&
            account.enabled &&
            account.credential !== undefined &&
            account.credential.expiresAt > input.now
        )
        .map((account) =>
          Candidate.make({
            accountId: account.accountId,
            activeReservations: 0,
            requiresReauthentication: account.requiresReauthentication,
            ...(account.usage === undefined ? {} : { usage: account.usage })
          })
        )
      const lease = yield* routing
        .acquire({
          candidates,
          now: input.now,
          ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
        })
        .pipe(Effect.mapError(storeFailure))
      if (Option.isNone(lease)) {
        return Option.none<SubscriptionRouteGrant>()
      }
      const selected = yield* getAccount(sql, lease.value.accountId)
      if (
        Option.isNone(selected) ||
        selected.value.requiresReauthentication ||
        selected.value.credential === undefined
      ) {
        yield* routing.release(lease.value.leaseToken).pipe(Effect.mapError(storeFailure))
        return Option.none<SubscriptionRouteGrant>()
      }
      return Option.some(
        SubscriptionRouteGrant.make({
          credential: selected.value.credential,
          lease: lease.value
        })
      )
    })

    const renew: SubscriptionAccountStoreShape["renew"] = Effect.fn(
      "SqliteSubscriptionAccountStore.renew"
    )((leaseToken, now) => routing.renew(leaseToken, now).pipe(Effect.mapError(storeFailure)))

    const release: SubscriptionAccountStoreShape["release"] = Effect.fn(
      "SqliteSubscriptionAccountStore.release"
    )((leaseToken) => routing.release(leaseToken).pipe(Effect.mapError(storeFailure)))

    const recordResponse: SubscriptionAccountStoreShape["recordResponse"] = Effect.fn(
      "SqliteSubscriptionAccountStore.recordResponse"
    )(function* (input) {
      const account = yield* getAccount(sql, input.accountId)
      if (Option.isNone(account) || account.value.credential?.generation !== input.generation) {
        return
      }
      if (input.classification.kind === "reauth") {
        yield* markRequiresReauthentication(input.accountId, input.generation)
      }
      yield* routing
        .recordResponse(input.accountId, input.classification, input.now)
        .pipe(Effect.mapError(storeFailure))
    })

    const summary: SubscriptionAccountStoreShape["summary"] = Effect.fn(
      "SqliteSubscriptionAccountStore.summary"
    )((now) => routing.summary(now).pipe(Effect.mapError(storeFailure)))

    return SubscriptionAccountStore.of({
      acquire,
      claim,
      commitCredential,
      commitUsage,
      get,
      list,
      markRequiresReauthentication,
      recordResponse,
      remove,
      replaceCredential,
      release,
      releaseClaim,
      renew,
      seedIfAbsent,
      setEnabled,
      summary
    })
  }
)

export const sqliteSubscriptionAccountStoreLayer = (
  databasePath: string,
  config: RoutingConfig = defaultRoutingConfig
) => {
  const sql = SqliteClient.layer({
    filename: databasePath,
    spanAttributes: {
      "db.namespace": "codex-router",
      "service.name": "codex-router-bun"
    }
  })
  const migrations = SqliteMigrator.layer({
    loader: subscriptionMigrations
  }).pipe(Layer.provide(sql))
  const pragmas = Layer.effectDiscard(sqliteConnectionPragmas).pipe(Layer.provide(sql))
  const migratedSql = Layer.mergeAll(sql, migrations, pragmas)
  const crypto = BunCrypto.layer
  const routingInfrastructure = Layer.merge(migratedSql, crypto)
  const routing = sqliteRoutingStateFromSqlLayer(config).pipe(Layer.provide(routingInfrastructure))
  const dependencies = Layer.mergeAll(routingInfrastructure, routing)
  const store = Layer.effect(SubscriptionAccountStore, makeSqliteSubscriptionAccountStore()).pipe(
    Layer.provide(dependencies)
  )
  return Layer.merge(dependencies, store)
}
