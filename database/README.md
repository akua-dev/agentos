# AgentOS PostgreSQL migrations

This package is SQL-first. Ordered files under `migrations/` are the complete
executable database contract, including tables, roles, grants, RLS policies,
Functions and Triggers.

PostgreSQL is a required coordination dependency once AgentOS accepts durable
work or delegates an Agent. It may be provisioned only after the First Mate
runtime is online, but that bootstrap stage is not a database-free operating
mode. The schema stores accepted work, accountable ownership, handoffs,
Captain-gated decisions and durable coordination—not raw model reasoning,
harness transcripts, terminal output or a mirror of the selected issue tracker.

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

For the released in-cluster CloudNativePG shape, keep the generated password in
the mode-`0600` `~/.pgpass` file, mount only the cluster CA certificate, and
use a non-secret process-only URL:

```sh
workspace="$(mise run database:prepare)"
PGPASSFILE="$HOME/.pgpass" \
  PGSSLROOTCERT="/var/run/agentos/postgres/ca.crt" \
  NODE_EXTRA_CA_CERTS="/var/run/agentos/postgres/ca.crt" \
  DATABASE_URL="postgresql://agentos@agentos-postgres-rw:5432/agentos?sslmode=verify-full" \
  bun run --cwd "$workspace" migrate
```

The released First-Mate database patch mounts `ca.crt` at that path and sets
the same verification environment for direct clients. `verify-full` keeps
encryption, CA validation and Service-hostname verification intact; never
substitute libpq compatibility or a no-verify mode merely to bypass CNPG's
private CA. Revalidate this handoff when upgrading the PostgreSQL driver.
The migration config resolves the matching mode-`0600` pgpass entry into its
in-memory connection URL before Drizzle constructs `pg`; it never puts the
password in a command argument and avoids `pg`'s deprecated implicit pgpass
fallback.

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
code imports this database package. The separate `clis/pg-listen` workspace
owns the small generic `pg-listen <channel>` command and its runtime dependency;
it does not import this package, expose SQL, or replace direct `psql` use.
Do not use `drizzle-kit push`, `pull`, or non-custom `generate` in this package.

Use transactions where PostgreSQL permits them and add behavioral SQL tests
for allowed and forbidden access paths when schema behavior is introduced.

The initial migration creates one Fleet database contract in schema `agentos`
and reserves schema `local` for approved First-Mate experiments. External
provider payloads remain raw JSONB in `agentos.external_events`; the same rows
carry their small burst, claim and reconciliation state. There is no external
link table, reconciliation table, outbox or database wrapper service.

An external PostgreSQL endpoint and the optional self-hosted CloudNativePG
topology in `kubernetes/cloudnative-pg/` are equally supported paths. The
topology lives beside the SQL contract because both form the database
component, but it never becomes a second schema authority. Both paths apply the
same migration journal and security contract.

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
mutate themselves; Inbox writes begin with authentic senders and immutable read
content, with `0007` later adding direct hierarchy-edge routing. Tables without
a reviewed runtime write policy remain mutable only by First Mate as owner.

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

`0004_provision_agents.sql` adds the idempotent
`agentos.provision_agent` boundary. First Mate can create direct Second-Mate or
Crewmate identities; Second Mate can create only direct Crewmates; Crewmates
receive no execute grant. New rows remain in `provisioning` until their
separately approved principal, credential and runtime have been verified. An
exact retry returns the same UUID, a conflicting handle fails closed, and every
Second Mate requires a non-empty charter summary and scope in metadata. The
Function creates neither PostgreSQL roles nor Kubernetes resources.

`0005_durable_coordination_contracts.sql` makes core Mate artifacts explicit.
Captain rows carry Fleet or Mate-domain scope while every registered Agent
keeps the complete read view. Assignments store their authoritative brief,
resolved dispatch profile, final or handoff report and append-only handoff
link. `agentos.handoff_task_assignment` preserves one Task identity across an
atomic, idempotent transfer. Captain choices remain Inbox deliveries under a
stable unique `decision_key`; Scout and review Assignments attest the exact
open key set before completion, and resolution stores the exact answer while
releasing matching Task dependency edges in the same transaction. There is no
new decisions table or service. `tests/coordination-contracts.test.ts` exercises
these contracts against the full ordered migration chain in PGlite.

`0006_fleet_notifications.sql` adds transactional wake hints for actionable
coordination tables. Payloads contain only schema version, table and operation;
the listener must query durable rows after wake. PGlite tests prove committed
changes notify, rolled-back changes do not, and all intended tables are wired.

`0007_inbox_hierarchy_edge_routing.sql` makes the communication topology an
executable contract. Agent-authored Inbox delivery is accepted only between a
direct parent and child in either direction, including when First Mate writes
through the Fleet-owner login. Cross-domain requests therefore escalate to the
common ancestor for Task creation or routing instead of becoming lateral
messages. Released Captain-decision Functions retain their intentional
self-addressed and Captain-authored rows. `tests/inbox-routing.test.ts` proves
direct delivery, complete Fleet reads and forbidden self, grandparent, sibling
and cross-domain writes with real roles and RLS.

`0008_inbox_speech_act_vocabulary.sql` closes `inbox.kind` to `request`,
`question`, `answer`, `approval_request`, `approval`, `notification`,
`escalation`, `captain_decision` and `captain_decision_answer`. Adding the
constraint validates every existing row and fails closed on an unknown legacy
kind rather than guessing its meaning. `tests/inbox-vocabulary.test.ts` proves
unknown kinds fail, every released kind succeeds and the Captain-decision
Functions remain conformant.

`0009_inbox_receipt.sql` adds `agentos.receive_inbox(uuid)`, the idempotent
recipient-owned boundary for loading a delivery. It returns the row while
setting `read_at` in the same transaction, leaves `resolved_at` separate, rejects
ordinary senders and unrelated Agents, and preserves First Mate's owner-level
administrative repair. This makes read-but-unresolved delivery recoverable and
lets a Crewmate receive a durable row after only a concise Herdr doorbell.
`tests/inbox-receipt.test.ts` proves the receipt, retry and authorization paths.

`0010_preserve_runtime_privileges.sql` carries the cumulative runtime-grant
configuration forward while retaining `receive_inbox` execution. In particular,
adding the receipt primitive must not erase Second Mate's later Captain-domain,
Assignment-artifact or durable-coordination privileges. The full authorization
and coordination suites exercise the preserved grants with real roles.

`0011_agent_composition.sql` defines one versioned composition-manifest
contract for persistent Agents and bounded Assignments. A nullable
`agents.resolved_composition` is desired persistent state; the existing
`task_assignments.dispatch_profile` becomes the pinned Assignment-scoped form
of the same contract. PostgreSQL validates recognized material kinds, exact
provenance, content digests, safe relative entrypoints and matching harness
identity. The recognized materials are Markdown instructions and Agent Skills;
all other native runtime choices are preserved as opaque `settings` that
PostgreSQL deliberately does not interpret. The versioned top-level envelope
is closed so new native knobs cannot leak back into the core schema. Runtime
capabilities such as Mise, MCP and harness extensions remain native rather than
becoming material kinds.
Existing dispatch profiles are upgraded in place without losing their runtime
choices. Every registered Agent keeps the complete read view, while no child
runtime receives a new composition-update grant. The pure manifest validators
remain executable for registered table writers because PostgreSQL evaluates
the Assignment `CHECK` as its caller; the persistent mutation Functions remain
closed.
`tests/composition-manifests.test.ts` exercises accepted and rejected manifests,
harness consistency and real role permissions against the complete chain.

An Assignment's `brief`, `started_at` and `dispatch_profile` freeze when
execution starts. Its Agent cannot change to a harness that contradicts an
active Assignment. Genuinely corrupt active dispatch data can be corrected only
through `agentos.repair_task_assignment_dispatch` by First Mate with the
complete replacement brief, valid matching composition and a durable reason;
the prior values remain in Assignment metadata. Completed Assignment history
cannot be repaired in place.

Persistent composition changes go through
`agentos.replace_agent_composition` with an active Fleet- or Agent-scoped
Captain row under the exact `agent-composition-authority` topic and a durable
reason. An unrelated Captain preference is not mutation authority. Only First
Mate can change its own or a direct Second Mate's desired composition; the
immediately prior manifest is retained
in Agent metadata for one explicit rollback. Incorrect durable state uses the
separate `agentos.repair_agent_composition` path so repair is visible rather
than disguised as ordinary selection. These rows still do not claim that Pi,
files or Herdr loaded the desired setup.
