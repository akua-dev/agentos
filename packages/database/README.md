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
and apply pending migrations from a PVC-backed tooling workspace:

```sh
workspace="$(mise run database:prepare)"
DATABASE_URL="<approved process-only value>" bun run --cwd "$workspace" migrate
```

`database:prepare` copies only the reviewed package manifests, lockfile,
migration configuration and SQL into a content-addressed directory under the
agent's persistent home. It installs only this package's production
dependencies with Bun's frozen lockfile. The immutable First-Mate image remains
small, interrupted installs never become ready workspaces, and later runs reuse
the prepared directory.

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

Database topology is deliberately outside this package. A developer-selected
external endpoint and the self-hosted CloudNativePG shape in
`deploy/kubernetes/database/` are equal supported paths. Both apply this same
migration journal and security contract.

`tests/migration.test.ts` starts a fresh in-memory PGlite database, executes the
real migration and then runs `tests/0000_initial_fleet_schema.sql` against it.
The SQL test exercises constraints, Triggers and Functions before rolling its
fixtures back; it never inspects migration source text. PGlite is the fast
test boundary for migration behavior, including roles, Grants and RLS.

`0001_agent_authorization.sql` binds an existing PostgreSQL `session_user` to
an Agent without creating or storing credentials. First Mate must use the Fleet
owner role and is the database/schema administrator without needing PostgreSQL
cluster-superuser privileges. All other registered Agents use non-privileged
login roles. Every active registered Agent receives an unfiltered read view of
every Fleet table. RLS lets Second Mates manage their subtrees and Crewmates
mutate themselves; Inbox writes preserve authentic senders and immutable read
content. Tables without a reviewed runtime write policy remain mutable only by
First Mate as owner.

`0002_runtime_mutation_authorization.sql` opens the reviewed Task and Assignment
mutation paths. Mates create and assign work only inside their managed Agent
hierarchy; an actively assigned Crewmate can update work state but not rewrite
scope. Completed Assignments are immutable. `agentos.retire_agent` rejects
active Assignments and active child Agents instead of cascading a hidden
handoff. External claim, refresh, assertion, completion and release Functions
are executable only by First or Second Mate and require their supplied Agent ID
to match the authenticated `session_user`. Direct runtime updates to external
event coordination rows remain forbidden.

`tests/runtime-authorization.test.ts` applies all migrations around both
already-registered and later-registered roles, then exercises those allowed and
forbidden paths against PGlite.

`0003_initialize_fleet_owner.sql` requires the migration `session_user` to own
the released AgentOS tables. It creates the root `firstmate` Agent when absent,
or adopts one existing unbound active First Mate, and registers that row to the
same owner login. It rejects a separate migrator, multiple active First Mates or
a root already bound to another role, and its partial unique index preserves one
active Fleet root afterward. It creates neither roles nor credentials.
`tests/fleet-initialization.test.ts` verifies each initialization and recovery
path against isolated PGlite databases.
