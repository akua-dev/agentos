---
name: agentos-database
description: Inspect, provision, migrate, verify, and recover the AgentOS PostgreSQL database using released SQL assets. Use for database topology, schema versions, roles, grants, RLS, Functions, Triggers, inbox rules, fleet data, migration failures, or PostgreSQL bootstrap and recovery.
---

# Operate the AgentOS database

Treat versioned SQL and its tests as the database contract. Use direct PostgreSQL clients; do not introduce a wrapper service.

## Inspect before mutation

1. Identify the selected immutable AgentOS release. Require its version-neutral database manifest and ordered database migrations. CloudNativePG and PostgreSQL are external dependencies selected from current official releases during installation, not versions encoded in the AgentOS release.
2. Enumerate that release's ordered
   `database/migrations/` files and Drizzle migration journal.
3. Inspect the target endpoint, server version, database identity, schema version, installed roles and pending migrations without changing them.
4. For an in-cluster target, inspect `Cluster` resources, CNPG CRDs, admission webhooks and controller Deployments separately. CRDs without a Ready controller are an incomplete installation, not an available database platform.
5. Stop if required AgentOS release assets are missing. Never reconstruct production schema or Kubernetes resources from prose.
6. Explain whether the database is existing external, existing in-cluster, or awaiting approved provisioning.

## Select topology

Present an existing external or managed PostgreSQL endpoint and self-hosted CloudNativePG as equal viable paths. Neither is the implicit default. Explain the observed infrastructure, ownership, availability, backup and cost trade-offs, then let the developer choose. Validate any selected existing endpoint read-only with its approved credential source; do not copy it into Kubernetes merely to normalize the topology.

### Official CloudNativePG version guidance

Resolve versions from primary sources at installation time:

- [latest CloudNativePG release](https://github.com/cloudnative-pg/cloudnative-pg/releases/latest)
- [supported CloudNativePG, Kubernetes and PostgreSQL versions](https://cloudnative-pg.io/docs/current/supported_releases/)
- [installation and upgrade guidance](https://cloudnative-pg.io/docs/current/installation_upgrade/)
- [official PostgreSQL image catalogs](https://cloudnative-pg.io/docs/current/image_catalog/)
- [PostgreSQL container image requirements](https://cloudnative-pg.io/docs/current/container_images/)
- [published CloudNativePG image-catalog artifacts](https://github.com/cloudnative-pg/artifacts/tree/main/image-catalogs)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)

The `current` documentation and the artifacts branch move over time. Use them
to discover candidates, then reopen the selected CNPG version's documentation
and resolve mutable catalog entries to the exact observed commit and image
digests before proposing an installation.

When the developer selects self-hosted PostgreSQL:

1. Use CloudNativePG. Do not deploy a raw PostgreSQL Pod, StatefulSet, chart or embedded server.
2. Read the selected Kubernetes server version. Discover the newest stable, non-prerelease CloudNativePG release from the official project and verify from that release's official documentation that it supports the server version. Also discover the newest stable PostgreSQL release that this CloudNativePG version explicitly supports and publishes as an official operand. Do not infer compatibility from version numbers or use a mutable `latest` tag.
3. Inspect an existing controller before proposing change. Reuse it only when it is healthy, compatible with the selected Kubernetes server and supports the selected PostgreSQL operand. Do not take ownership of or upgrade a shared controller implicitly. If a compatible existing controller is not the newest release, present reuse and approved upgrade as choices rather than silently preferring either.
4. If no compatible controller runs, explain that its CRDs, webhooks, namespace and cluster-wide RBAC are cluster-scoped. Present the exact discovered CNPG and PostgreSQL versions and immutable image identities, then ask before installing it.
5. Obtain the exact tagged CNPG manifest from the official release, verify its official signature or published checksum, and resolve every installed controller image to a digest. Apply only after approval, then verify rollout, version and observed image IDs before creating a database Cluster.
6. Create an ephemeral rendered copy of the selected AgentOS database manifest and inject the chosen PostgreSQL operand as `tag@sha256`; never edit the canonical release asset. Apply that rendered manifest. The initial shape creates `Cluster/agentos-postgres` in `agentos`, one instance, a 20 GiB PVC, data checksums, database and owner `agentos`, and no network-enabled superuser. Explain that this minimal path is not HA and has no reviewed backup policy yet.
7. Wait for the CNPG `Ready` condition, one Ready instance, Bound PVC, selected operand image ID, `agentos-postgres-rw` Service and `agentos-postgres-app` Secret. Never connect directly to a PostgreSQL Pod.

Stop if official provenance cannot be verified. For an existing database Cluster,
observe and retain its PostgreSQL version; finding a newer release never
authorizes an implicit major, minor or operand upgrade.

Record the selected CNPG and PostgreSQL versions, source URLs, verification evidence and observed image IDs in Fleet operational state. They describe an installation, not the immutable AgentOS release.

Do not add `postInitSQL` to the CNPG resource. Drizzle's ordered journal remains the only migration authority.

## Handle credentials

Use the CNPG-generated `agentos-postgres-app` identity for self-hosted PostgreSQL, never the superuser. Read Secret values only after credential approval and never print them.

For direct `psql`, copy only the Secret's `pgpass` value into `~/.pgpass` on the owning agent PVC without exposing stdout, then set mode `0600`. From an Agent Pod in `agentos`, connect directly through the `agentos-postgres-rw` Service with explicit database and user names; do not create a port-forward inside the cluster. Refresh that file after credential rotation.

For Drizzle migrations against that in-cluster CNPG Service, keep the password
in `~/.pgpass` and inject this non-secret URL into only the migration process:
`postgresql://agentos@agentos-postgres-rw:5432/agentos?uselibpqcompat=true&sslmode=require`.
The release-pinned `pg` 8 driver otherwise treats `sslmode=require` as
certificate verification and rejects CNPG's private cluster CA. The explicit
libpq compatibility flag keeps TLS required without copying a password into the
URL. Revalidate this option when the release upgrades to `pg` 9 or later.

For an external endpoint, prefer an approved Kubernetes Secret or mode-`0600` file owned by the persistent agent. Keep the connection URI out of prompts, command arguments, shell history and normal logs.

Apply the migration chain with the login that owns the Fleet's released AgentOS
tables. The released initialization migration creates or adopts the root
First-Mate row and binds it to that same `session_user`; never add a separate
migrator or manually map First Mate. This makes First Mate the Fleet
database/schema administrator, but does not require PostgreSQL cluster
`SUPERUSER`, `CREATEDB`, `CREATEROLE` or `BYPASSRLS`.

Create every other Agent login through the selected database platform's
approved role-management path, outside AgentOS migrations. Require it to have
none of those privileges and no inherited owner capability. After creating the
Agent row, bind the exact role name with
`agentos.register_agent_principal(agent_id, database_role)`. Keep the credential
in that Agent's approved Secret or mode-`0600` file; never store it in Fleet rows.
An active registered Agent receives the complete released Fleet read view; RLS
must not hide individual rows by role or hierarchy. Unregistered and retired
runtime logins receive no Fleet rows. Apply hierarchy only to mutation policies.

## Coordinate runtime work

- Create direct child identities only through `agentos.provision_agent`.
  First Mate may provision a Second Mate or Crewmate; Second Mate may provision
  only a Crewmate; Crewmates receive no execute grant. Treat an exact returned
  UUID as an idempotent retry and any handle conflict as a hard stop. A Second
  Mate requires `metadata.charter.summary` and `metadata.charter.scope`.
  Principal creation and credential delivery remain separate, approved
  platform operations followed by `agentos.register_agent_principal`.
- First Mate administers all Fleet work. A Second Mate may create Tasks and
  Assignments only for its managed Agent subtree. A Crewmate may update the
  state of an active own Assignment and its Task, but may not rewrite Task
  scope. Treat a completed Assignment as immutable history.
- Before retiring an Agent, explicitly complete or reassign every active Task
  Assignment and hand off every active child Agent. Call
  `agentos.retire_agent(agent_id, status_text)`; never emulate retirement with a
  direct status edit or an automatic cascade.
- Only First and Second Mates reconcile external events. Pass only the caller's
  own Agent ID to the released claim, refresh, assertion, completion and release
  Functions; PostgreSQL verifies it against `session_user`. Do not update claim
  columns directly.
- Keep model reasoning and provider CLI calls outside database transactions.
  Immediately before committing local effects, assert that the claim is current.
  Apply coupled Task and Inbox updates and complete the claim in one short
  transaction. On a provider or reasoning failure, release the claim with useful
  error text; never hide the failure behind an outbox.

## Apply released assets

1. Ask before provisioning PostgreSQL, creating a database or role, changing grants, or applying migrations.
2. Apply the topology selected by the developer. Do not rank external PostgreSQL ahead of self-hosted CloudNativePG, or vice versa.
3. Before the first migration on an agent, explain that the pinned Drizzle and PostgreSQL driver dependencies will occupy about 90 MB on its PVC and ask for tooling-installation approval. From the selected release's `database/` directory, run `mise run database:prepare`. It installs only `@agentos/database` production dependencies from the release root `bun.lock` into a content-addressed persistent workspace and reuses a completed workspace on later runs. Trust its printed package path; do not run a second ad hoc `bun install` in that workspace.
4. Apply pending migrations as the selected Fleet-owner login from the path printed by `database:prepare` with `bun run --cwd <prepared-path> migrate`, injecting `DATABASE_URL` and, when used, `PGPASSFILE` into only that process from the approved secret source. For the released in-cluster CNPG shape, use the non-secret URL and `~/.pgpass` handoff defined above. Drizzle Kit owns ordering and the applied-migration journal. Stop on a separate migration identity instead of weakening the automatic root binding.
5. Use released Functions and Triggers for shared invariants instead of rewriting equivalent ad hoc SQL in every agent session.
6. Use released RLS policies and role grants; never bypass them to make a failing workflow pass.

AgentOS is SQL-first. Never use `drizzle-kit push`, `pull`, or non-custom `generate`, and never introduce a TypeScript schema as database authority. New migrations begin with the package's `migration:new -- --name <name>` command and contain only reviewed SQL.

## Verify

- Confirm schema version and migration checksums, then verify that `current_agent_id()` resolves the single active root First Mate for the Fleet-owner session.
- Exercise allowed and forbidden access with actual Agent roles when the selected release defines them. Until then, do not admit mutually untrusted agents to the database.
- Verify the invariants defined by the installed SQL tests and confirm direct `psql` access through the approved non-superuser identity.
- Verify the owning agent can reconnect after pod replacement without exposing credentials.

On partial failure, preserve committed migrations, report the first unverified boundary, and use the release's recovery procedure. Do not improvise down-migrations or destructive repair.
