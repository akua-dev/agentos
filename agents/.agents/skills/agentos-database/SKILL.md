---
name: agentos-database
description: Inspect, provision, migrate, verify, and recover the AgentOS PostgreSQL database using released SQL assets. Use for database topology, schema versions, roles, grants, RLS, Functions, Triggers, inbox rules, fleet data, migration failures, or PostgreSQL bootstrap and recovery.
---

# Operate the AgentOS database

Treat versioned SQL and its tests as the database contract. Use direct PostgreSQL clients; do not introduce a wrapper service.

## Inspect before mutation

1. Identify the selected AgentOS release and enumerate its ordered `packages/database/migrations/` files and Drizzle migration journal.
2. Inspect the target endpoint, server version, database identity, schema version, installed roles and pending migrations without changing them.
3. Stop if required SQL or verification assets are missing. Never reconstruct production schema from prose.
4. Explain whether the database is existing external, existing in-cluster, or awaiting approved provisioning.

## Apply released assets

1. Ask before provisioning PostgreSQL, creating a database or role, changing grants, or applying migrations.
2. Prefer the developer-selected reachable database. Recommend the released in-cluster path only when none is selected.
3. Apply pending released migrations through the `@agentos/database` package's `migrate` script, with `DATABASE_URL` injected from the approved secret source. Drizzle Kit owns ordering and the applied-migration journal.
4. Use released Functions and Triggers for shared invariants instead of rewriting equivalent ad hoc SQL in every agent session.
5. Use released RLS policies and role grants; never bypass them to make a failing workflow pass.

AgentOS is SQL-first. Never use `drizzle-kit push`, `pull`, or non-custom `generate`, and never introduce a TypeScript schema as database authority. New migrations begin with the package's `migration:new -- --name <name>` command and contain only reviewed SQL.

## Verify

- Confirm schema version and migration checksums.
- Exercise allowed and forbidden access with the actual First-, Second-, and Crewmate database roles.
- Verify message immutability after first read and any other invariants defined by the installed SQL tests.
- Verify the owning agent can reconnect after pod replacement without exposing credentials.

On partial failure, preserve committed migrations, report the first unverified boundary, and use the release's recovery procedure. Do not improvise down-migrations or destructive repair.
