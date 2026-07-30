import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export const subscriptionMigrations = SqliteMigrator.fromRecord({
  "1_subscription_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS subscription_accounts (
        account_id TEXT PRIMARY KEY NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        requires_reauth INTEGER NOT NULL CHECK(requires_reauth IN (0, 1)),
        credential_generation INTEGER,
        credential_expires_at INTEGER,
        credential_json TEXT,
        updated_at INTEGER NOT NULL,
        CHECK(
          (credential_generation IS NULL AND credential_expires_at IS NULL AND credential_json IS NULL)
          OR
          (credential_generation IS NOT NULL AND credential_expires_at IS NOT NULL AND credential_json IS NOT NULL)
        )
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS refresh_claims (
        account_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('credential', 'usage')),
        claim_token TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, operation),
        FOREIGN KEY(account_id) REFERENCES subscription_accounts(account_id) ON DELETE CASCADE
      )
    `.withoutTransform
    yield* sql`
      CREATE INDEX IF NOT EXISTS refresh_claims_expiry
      ON refresh_claims(expires_at)
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS usage_snapshots (
        account_id TEXT PRIMARY KEY NOT NULL,
        observed_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `.withoutTransform
  }),
  "2_routing_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS assignments (
        session_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS reservations (
        lease_token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        session_key TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE INDEX IF NOT EXISTS reservations_account_expiry
      ON reservations(account_id, expires_at)
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS blocks (
        account_id TEXT PRIMARY KEY,
        block_kind TEXT CHECK(block_kind IN ('quota', 'transient') OR block_kind IS NULL),
        retry_at INTEGER,
        requires_reauth INTEGER NOT NULL DEFAULT 0 CHECK(requires_reauth IN (0, 1))
      )
    `.withoutTransform
  })
})
