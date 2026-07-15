# AgentOS PostgreSQL migrations

This package is SQL-first. Ordered files under `migrations/` are the complete
executable database contract, including tables, roles, grants, RLS policies,
Functions and Triggers.

Create a journaled empty migration, then write the approved SQL into it:

```sh
bun run migration:new -- --name <name>
```

Check the migration history without connecting to a database:

```sh
bun run migration:check
```

After explicit approval, inject `DATABASE_URL` from a safe credential source
and apply pending migrations:

```sh
bun run migrate
```

`drizzle.tooling.ts` is deliberately empty. It only satisfies Drizzle Kit's
custom-migration command and must never become a database schema source.
`drizzle-orm` is installed only because that command requires the package, and
`pg` is the PostgreSQL driver used by the migration runner. No AgentOS runtime
code imports either package.
Do not use `drizzle-kit push`, `pull`, or non-custom `generate` in this package.

Use transactions where PostgreSQL permits them and add behavioral SQL tests
for allowed and forbidden access paths when schema behavior is introduced.

The initial migration creates one Fleet database contract in schema `agentos`
and reserves schema `local` for approved First-Mate experiments. External
provider payloads remain raw JSONB in `agentos.external_events`; the same rows
carry their small burst, claim and reconciliation state. There is no external
link table, reconciliation table, outbox or database wrapper service.

`tests/migration.test.ts` starts a fresh in-memory PGlite database, executes the
real migration and then runs `tests/0000_initial_fleet_schema.sql` against it.
The SQL test exercises constraints, Triggers and Functions before rolling its
fixtures back; it never inspects migration source text. PGlite is the fast
default for migration behavior. Grants, RLS and multi-connection concurrency
must additionally be verified against a real PostgreSQL server when introduced.
