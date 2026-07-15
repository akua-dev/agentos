---
name: agentos-database
description: Inspect, provision, migrate, verify, and recover the AgentOS PostgreSQL database using released SQL assets. Use for database topology, schema versions, roles, grants, RLS, Functions, Triggers, inbox rules, fleet data, migration failures, or PostgreSQL bootstrap and recovery.
---

# Operate the AgentOS database

Treat versioned SQL and its tests as the database contract. Use direct PostgreSQL clients; do not introduce a wrapper service.

## Inspect before mutation

1. Identify the selected immutable AgentOS release. Require its database manifest, PostgreSQL image digest, CloudNativePG version, supported Kubernetes minor versions, controller digest, operator-manifest URL and operator-manifest SHA-256 checksum.
2. Enumerate that release's ordered `packages/database/migrations/` files and Drizzle migration journal.
3. Inspect the target endpoint, server version, database identity, schema version, installed roles and pending migrations without changing them.
4. For an in-cluster target, inspect `Cluster` resources, CNPG CRDs, admission webhooks and controller Deployments separately. CRDs without a Ready controller are an incomplete installation, not an available database platform.
5. Stop if required release assets or verification metadata are missing. Never reconstruct production schema or Kubernetes resources from prose.
6. Explain whether the database is existing external, existing in-cluster, or awaiting approved provisioning.

## Select topology

Prefer a reachable developer-selected external or managed PostgreSQL database. Validate it read-only with its approved credential source; do not copy it into Kubernetes merely to normalize the topology.

When the developer selects self-hosted PostgreSQL:

1. Use CloudNativePG. Do not deploy a raw PostgreSQL Pod, StatefulSet, chart or embedded server.
2. Require the target Kubernetes server minor version to be listed in the selected release. Reuse a healthy controller only when its observed version and required APIs match the versions reviewed by that release. Do not take ownership of or upgrade a shared controller implicitly.
3. If no compatible controller runs, explain that its CRDs, webhooks, namespace and cluster-wide RBAC are cluster-scoped. Ask before installing or reconciling it.
4. Download the exact operator manifest advertised by the AgentOS release, verify its bytes against the advertised SHA-256 checksum, then apply it server-side. Pin the controller Deployment to the release's controller image digest and verify its rollout plus observed image ID before creating a database Cluster.
5. Apply only the selected AgentOS release's versioned database manifest. The initial path creates `Cluster/agentos-postgres` in `agentos`, one PostgreSQL 18.4 instance, a 20 GiB PVC, data checksums, database and owner `agentos`, and no network-enabled superuser. Explain that this fastest path is not HA and has no reviewed backup policy yet.
6. Wait for the CNPG `Ready` condition, one Ready instance, Bound PVC, pinned operand image ID, `agentos-postgres-rw` Service and `agentos-postgres-app` Secret. Never connect directly to a PostgreSQL Pod.

Do not add `postInitSQL` to the CNPG resource. Drizzle's ordered journal remains the only migration authority.

## Handle credentials

Use the CNPG-generated `agentos-postgres-app` identity for self-hosted PostgreSQL, never the superuser. Read Secret values only after credential approval and never print them.

For direct `psql`, copy only the Secret's `pgpass` value into `~/.pgpass` on the owning agent PVC without exposing stdout, then set mode `0600`. From an Agent Pod in `agentos`, connect directly through the `agentos-postgres-rw` Service with explicit database and user names; do not create a port-forward inside the cluster. Refresh that file after credential rotation.

For an external endpoint, prefer an approved Kubernetes Secret or mode-`0600` file owned by the persistent agent. Keep the connection URI out of prompts, command arguments, shell history and normal logs.

## Apply released assets

1. Ask before provisioning PostgreSQL, creating a database or role, changing grants, or applying migrations.
2. Prefer the developer-selected reachable database. Offer the released CNPG path only when none is selected or the developer requests self-hosting.
3. Before the first migration on an agent, explain that the pinned Drizzle and PostgreSQL driver dependencies will occupy about 90 MB on its PVC and ask for tooling-installation approval. From the selected release's `packages/database/` directory, run `mise run database:prepare`. It installs only `@agentos/database` production dependencies from the release `bun.lock` into a content-addressed persistent workspace and reuses a completed workspace on later runs. Trust its printed package path; do not run a second ad hoc `bun install` in that workspace.
4. Apply pending migrations from the path printed by `database:prepare` with `bun run --cwd <prepared-path> migrate`, injecting `DATABASE_URL` into only that process from the approved secret source. Drizzle Kit owns ordering and the applied-migration journal.
5. Use released Functions and Triggers for shared invariants instead of rewriting equivalent ad hoc SQL in every agent session.
6. Use released RLS policies and role grants; never bypass them to make a failing workflow pass.

AgentOS is SQL-first. Never use `drizzle-kit push`, `pull`, or non-custom `generate`, and never introduce a TypeScript schema as database authority. New migrations begin with the package's `migration:new -- --name <name>` command and contain only reviewed SQL.

## Verify

- Confirm schema version and migration checksums.
- Exercise allowed and forbidden access with actual Agent roles when the selected release defines them. Until then, do not admit mutually untrusted agents to the database.
- Verify the invariants defined by the installed SQL tests and confirm direct `psql` access through the approved non-superuser identity.
- Verify the owning agent can reconnect after pod replacement without exposing credentials.

On partial failure, preserve committed migrations, report the first unverified boundary, and use the release's recovery procedure. Do not improvise down-migrations or destructive repair.
