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
  DATABASE_URL="postgresql://agentos@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=verify-full" \
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
Assignments store their authoritative brief,
historical dispatch profile, final or handoff report and append-only handoff
link. `agentos.handoff_task_assignment` preserves one Task identity across an
atomic, idempotent transfer. Captain choices remain Inbox deliveries under a
stable unique `decision_key`; Scout and review Assignments attest the exact
open key set before completion, and resolution stores the exact answer while
releasing matching Task dependency edges in the same transaction. There is no
new decisions table or service. The later `0016` forward migration removes the
obsolete dispatch-profile surface without rewriting this published migration.
`tests/coordination-contracts.test.ts` exercises these contracts against the
full ordered migration chain in PGlite.

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

`0011_agent_composition.sql` is retained byte-for-byte because it shipped in a
published release. Its composition columns, validators and Functions are
removed only by the append-only `0016` migration.

`0012_atomic_task_acceptance.sql` adds the idempotent
`agentos.create_task_with_assignment` and `agentos.accept_backlog_task`
Functions. A new accepted outcome or a deliberately accepted backlog Task gets
its first accountable Assignment in one transaction; an unassigned Task
remains backlog. `tests/atomic-acceptance.test.ts` exercises the acceptance and
retry paths.

`0013_current_mate_bearings.sql` adds the read-only
`agentos.current_mate_bearings()` projection for an authenticated Mate's
durable reconciliation references. It excludes message bodies, external
payloads, runtime health and routing decisions. `tests/current-mate-bearings.test.ts`
exercises its shape and authorization.

`0014_targeted_mate_notifications.sql` routes transactional table-and-operation
wake hints to deterministic responsible Mate channels instead of the global
channel. The hints remain non-secret routing signals; durable rows remain the
source of truth. `tests/targeted-notifications.test.ts` exercises routing,
rollback and channel isolation.

`0015_mate_memory.sql` removes the legacy shared Captain preference table
after failing closed when any active row still needs preservation. Private
context instead belongs to each persistent Mate's PVC. Exact Captain choices
remain durable Inbox speech acts. The migration updates notifications,
bearings, runtime grants and RLS references while leaving existing Tasks and
Assignments unchanged.

`0016_unify_agentos_package.sql` removes the superseded persistent-composition
and dispatch-profile database surface after AgentOS customization moved to one
Pi-native package. It preserves Tasks, Assignments, handoff history and
idempotent acceptance evidence, migrates stored acceptance requests to the
new signature, and reapplies runtime grants. The published-history test locks
all first 16 migration tags, timestamps and checksums; the package-unification
test exercises the forward upgrade from that exact historical schema.

`0017_runtime_operation_journal.sql` adds the resumable runtime-operation
contract used around native Kubernetes and Herdr work. A caller-selected UUID
binds one operation to its target Agent, supervising owner, optional
Assignment, namespace, workload, action, SHA-256 desired-render digest and a
closed list of retained PVC/worktree identities and dispositions. Exact begin
retries return the same UUID; conflicting identity, owner or render fails
closed, and a partial unique index permits only one active operation per Agent.

Mates advance operations only through `begin_runtime_operation`,
`observe_runtime_operation`, `complete_runtime_operation`,
`fail_runtime_operation` and `supersede_runtime_operation`. The current phase
is paired with append-only phase events so interruption after prepare, apply,
workload readiness or harness readiness can be repaired forward from fresh
native observations. Supersession atomically links a replacement operation to
the same Agent, Assignment, namespace, workload and action; it creates no
Agent, Task, Assignment, PVC or worktree. Teardown refuses active Assignments
and requires an explicit disposition for the Agent's recorded PVC. Completed
operations and all events are immutable.

The journal deliberately stores no Kubernetes YAML or status, Herdr output,
logs, transcripts, credentials or heartbeats. Registered Agents retain the
Fleet-wide read view; only First and Second Mates receive the hierarchy-checked
Functions, and no runtime controller or database wrapper service is added.

`0018_access_control_plane.sql` adds the durable half of the narrow First-Mate
provider-access control API. Captain ceilings and reusable profile versions are
immutable and contiguous; profile publication locks the current head and
rejects a stale expected version, any unknown capability/resource/environment,
an excessive rate class, or an expiry beyond the current ceiling. Exact
operation-ID and request-digest retries return the one committed version.

Mate and active Assignment bindings use a separate repair-forward journal.
A create remains `pending` and a revoke remains `active` until the Effect core
executor has applied the one or two closed OpenFGA tuple/check stages, checked
every affected decision with higher consistency, and durably advanced each
stage. Condition replacement deletes and verifies deny before rewriting, so it
fails closed. Only the final short transaction activates or revokes the binding
and appends audit. A ceiling revision with live bindings remains `pending` until
one complete-subject reconciliation is verified; completion atomically
supersedes the old ceiling and activates the new one.
The journal records actor and ServiceAccount identity, target, old/new version,
finite reason, decision and correlation ID; tuple/check plans have closed
fields and cannot carry credentials or provider payloads. Profiles, phase
events, completed operation identity and audit are immutable. Registered Agents
can inspect the Fleet-wide rows, but only First Mate receives the mutation
Functions. `tests/access-control-plane.test.ts` exercises bounds, concurrency,
retry, grants, staged ceiling shrink, Assignment binding, Grants/RLS, privacy and
immutability against the full migration chain.

`0019_egress_authorizer_reads.sql` creates the narrow PostgreSQL boundary used
by `agentos-egress-authz`. It does not create a login or credential. The
database operator must create a dedicated non-privileged login through the
approved secret workflow, then the AgentOS schema owner applies the reviewed
grant configurator:

```sql
SELECT agentos.configure_egress_authorizer_privileges(
  'agentos_egress_authz'::name
);
```

The configurator rejects a superuser, database/role creator, replication or
`BYPASSRLS` role and rejects inherited role memberships. It removes direct
schema, table, sequence and Function grants before granting only these readers:

- `read_egress_workload_agents(text, text)`;
- `read_egress_assignments(uuid)`; and
- `read_egress_policy_snapshots(jsonb)`.

`0020_provider_budget_enforcement.sql` adds the exact reservation function.
`0021_provider_budget_provider_settlement.sql` adds provider-side settlement
without accepting the authorized Mate or Assignment subject. After `0021`, the
configurator grants `reserve_provider_budget(...)` and
`settle_provider_budget_for_provider(...)`; it explicitly removes the older
subject-bearing `settle_provider_budget(...)` grant.

Run the configurator during install and after an upgrade before making the
authorizer ready. Do not register this login as an Agent principal: it is a
service identity with narrower access than the Fleet-wide Agent read view.
Supply its password and verified TLS connection configuration only to the
authorizer through `Secret/agentos-egress-authz-database`, key `database-url`,
created by the approved managed-secret workflow. The authorizer Deployment
must never mount CloudNativePG's `agentos-postgres-app` owner credential. Never
place either credential in a migration, manifest value, command argument, log
or error.

The workload reader resolves an exact namespace/Pod locator. Fleet and domain
come only from a current active mate or Assignment access binding; it never
parses a namespace name or trusts a caller label. Multiple scopes remain
multiple rows so the Effect identity store rejects the lookup as ambiguous.
The Assignment reader returns only non-ended candidates for the selected
Agent.

The policy reader returns binding, immutable profile version and head,
binding/profile ceiling references, the exact ceiling, pending-ceiling state
and in-progress rollout state in one PostgreSQL statement snapshot. The Effect
store applies closed Schema decoding and rejects missing or duplicate rows,
pending/expired bindings, subject/reference mismatch, stale profile heads,
pending or inactive ceilings, future effective times and unfinished rollout.
Database and decoding failures are finite content-free tagged errors; raw SQL,
parameters, PostgreSQL errors and credentials never enter the domain failure.
`tests/egress-authorizer-reads.effect.test.ts` proves the real role boundary,
including removal of deliberately broad grants, exact reads and denial to an
unrelated login.

`0024_runtime_operation_workload_provenance.sql` binds compiler-originated
runtime custody to all three reviewed identities: typed spec version/digest,
generated-overlay digest, and rendered-resource digest. Workload callers use
`begin_workload_runtime_operation` and
`supersede_workload_runtime_operation`; an exact retry must match every digest,
so a changed typed spec cannot masquerade as the same operation merely because
it happens to render the same Kubernetes resources. Generic non-workload
operations retain the `0017` Functions and null workload provenance.

The workload provenance is all-or-none, immutable after its initial prepared
bind, and contains no spec, overlay, YAML, Secret, status, log, or session
content. Existing generic operations remain valid across the forward
migration. First and Second Mates receive the hierarchy-checked workload
Functions; Crewmates retain read-only Fleet visibility and cannot bind or
directly update provenance. The workload recovery suites exercise exact and
conflicting retries, exact supersession, forward upgrade, phase repair, stable
Agent/Task/Assignment identities, and retained-resource custody. The published
history suite also requires every ordered SQL file to occur exactly once at a
contiguous journal index, preventing an executable migration from silently
falling outside the journal.

`0025_assignment_execution_epochs.sql` records bounded execution attempts
separately from the Assignment. `begin_assignment_execution_epoch` binds one
active epoch to the exact Agent, Assignment, optional matching runtime
operation, and bounded provider-native session reference. The table stores no
brief, report, prompt, transcript, terminal output, provider payload,
credential, Kubernetes status, or Herdr status. Every registered Agent retains
Fleet-wide read visibility; only the assigned Agent or supervising Mate can
begin, exhaust, or complete, and only the supervising Mate can resume,
reassign, or stop.

Retry ceilings are derived from the closed failure class: overload/transport
5, stream 3, protocol/provider/harness/runtime 2, and
authentication/policy/capacity 1. `exhaust_assignment_execution_epoch` accepts
only the exact ceiling. Transient recovery requires `boundary:<opaque>`;
authentication and policy require `authority:<opaque>`; capacity requires a
different matching rollout/recover runtime operation already observed at
`harness_ready` or `completed`. `resume_assignment_execution_epoch` preserves
the Agent, Assignment, native session and ordinary runtime identity while
linking exactly one successor epoch. `reassign_assignment_execution_epoch`
delegates atomically to `handoff_task_assignment`;
`stop_assignment_execution_epoch` ends the same Assignment and keeps its
durable report there rather than in the epoch table. Every transition is
row-locked, exact-retry idempotent, and terminal history is immutable. The
Effect projection exposes only a closed failure class, recovery class and
attempt as metric dimensions; Agent, Assignment, operation, and session
correlations remain protected telemetry.
