<p align="center">
  <img src="docs/assets/agentos-hero.png" alt="AgentOS — a persistent fleet of engineering agents" width="1200">
</p>

<h1 align="center">AgentOS</h1>

<p align="center">
  <strong>Persistent engineering agents for Kubernetes.</strong>
</p>

<p align="center">
  Agent-native · Kubernetes-native · PostgreSQL-backed · Human-controlled
</p>

AgentOS turns one trusted coding agent into a durable engineering fleet: a persistent First Mate, optional domain-owning Second Mates, and task-scoped Crewmates working across repositories without losing their sessions, tools or context.

The model remains the decision-maker. AgentOS supplies the durable state, visible terminals and deterministic infrastructure mechanics around it.

## Start with your agent

You do not need to clone this repository, install a CLI or understand Kubernetes manifests first. Give the following prompt to an existing coding agent:

```text
Fetch and read https://raw.githubusercontent.com/akua-dev/agentos/main/BOOTSTRAP.md.
Inspect my environment read-only first and guide me interactively through establishing a persistent First Mate in Kubernetes.
```

The agent inspects what already exists, explains the viable path and asks before credentials, login, cost, cluster creation, RBAC or installation. It can use an existing Kubernetes cluster or offer Akua Zero-to-Cluster as an optional path.

Installation uses a versioned single-file manifest from an immutable GitHub
release. Its init and runtime containers all use the same public
`ghcr.io/akua-dev/agentos` image pinned by OCI digest.

For an existing cluster, the temporary local agent needs a working `kubectl`
context and a browser for interactive provider login. It does not need a local
AgentOS clone, Mise, Bun, Node, Docker, Helm, or PostgreSQL. Mise is part of the
persistent First-Mate image and manages that agent's tools on its PVC.

## The crew

- **Captain** — the developer. Owns intent, approvals, credentials, cost and infrastructure decisions.
- **First Mate** — the persistent fleet lead. Maintains the truthful system view and coordinates work.
- **Second Mate** — an optional persistent supervisor for a delegated product or engineering domain.
- **Crewmate** — a bounded working agent in its own repository or worktree, using the best supported harness for the task.

First and Second Mates use Pi where AgentOS needs deep lifecycle customization. Crewmates may use Pi, Codex or another verified coding harness.

## Why it exists

- **Persistent by design.** Agent homes and unfinished work survive disconnects and pod replacement.
- **Visible and recoverable.** Herdr keeps real agent terminals attachable instead of hiding work behind an opaque orchestrator.
- **Durably coordinated.** PostgreSQL holds tasks, inbox delivery, hierarchy, learnings and external events.
- **Directly tool-using.** Agents work with SQL, Git, Kubernetes and provider CLIs instead of talking through unnecessary wrapper services.
- **Human-controlled.** Sensitive or costly actions remain explicit approval boundaries.

> [!NOTE]
> AgentOS is under active development. This repository now includes the first persistent First-Mate runtime slice alongside the architecture, bootstrap workflow, Fleet database and toolchain; it is not yet a finished production distribution.

## Develop

The implementation is a Bun monorepo whose toolchain is pinned through Mise:

```sh
cd agentos
mise install
bun run check
```

Bun reports the release-selected `1.4.0` canary baseline. Package-specific instructions live with the package they govern.
See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the local Kubernetes workflow and
repository conventions.

---

## Architecture

AgentOS is an agent-native fleet system for persistent coding agents in Kubernetes.
The model remains the decision-maker; repository code implements only deterministic, reviewable mechanics.

### System boundaries

Each kind of state has one authority:

| Concern | Authority |
| --- | --- |
| Durable fleet data | PostgreSQL |
| Live workload state | Kubernetes |
| Terminal and harness runtime | Herdr inside each runtime pod |
| Agent home and unfinished work | Agent-owned PVC |
| Delivered code | Git and its remote |

AgentOS does not continuously mirror one authority into another.
PostgreSQL stores pod locators, not heartbeats; Kubernetes is inspected when live state matters.
Terminal output stays in the runtime unless a deliberate workflow archives a specific artifact.

### Agents and runtime pods

First Mates own the fleet. Second Mates supervise delegated domains. Crewmates perform bounded work.
The initial supported First- and Second-Mate harness is Pi because AgentOS customizes its skills, extensions, lifecycle and health reporting.
Working agents may use Pi, Codex, or another harness verified by the selected AgentOS release.

Each agent has its own identity and persistent home PVC.
Each agent runs in its own runtime pod with a dedicated ServiceAccount, home
PVC, database principal and pod-local Herdr server. A responsible Mate selects
the workload image and creates the reviewed per-agent Kustomize overlay with
native `kubectl` commands.

First and Second Mates use the same small `agentos` image and the same shared
StatefulSet base. Their Kustomize overlays explicitly select the role working
directory, environment, lifecycle tasks and credentials. The image contains
Mise, pinned Bun and the locked AgentOS tool definitions; an init container
installs Node and the remaining startup-critical Fleet tools onto the Mate's persistent home.
Ordinary tool additions remain in that Mise-managed home. Crewmates instead
receive a task-suited image selected by the responsible Mate. The judgment-based
dispatch profile
may add an optional `image` beside `harness`, `model` and `effort`; omission uses
the released lightweight default, while a remote image must come from an
approved registry and be pinned by digest. Large language- or Codex-oriented
images are therefore explicit task costs, not the universal fleet runtime.

One Herdr server runs per runtime pod and owns that pod's workspaces, tabs, panes, terminal processes, runtime status and native harness session references.
Client detach leaves processes running. After a pod replacement, Herdr restores its layout and asks supported harnesses to resume from their own persistent sessions.

Herdr is not a fleet database.
Its CLI and socket API are used locally for attach, read, send, wait, layout and debugging.
Outside the cluster, a human or seed agent resolves the target Pod with native
`kubectl` using an explicit Kubernetes context, enters that Pod, and invokes
its real Herdr terminal. Running Mates use the same native tools with their
in-cluster credentials.

A First Mate may arrange central fleet workspaces whose panes attach to Herdr sessions in other pods through Kubernetes exec.
This is only a user-facing view; the remote pod-local sessions remain authoritative.

### Delegation and supervision

The Captain has one regular fleet interface: First Mate.
First Mate does not perform project-specific coding, investigation, planning, bug reproduction or audits itself.
It may inspect projects read-only to understand and route work, and it may mutate reviewed Fleet operational state, but it delegates project work to a charter-matched Second Mate or a bounded Crewmate.
The running AgentOS checkout is First Mate's narrow self-maintenance exception: it may change shared AgentOS source directly only with Captain approval, no active direct report and the normal reviewed delivery path.
If any direct report is active, First Mate delegates AgentOS source changes too because hands-on work competes with supervision.

A Second Mate uses the same architecture inside one persistent charter.
It delegates project work to its own Crewmates, manages only its direct subtree and returns Captain-relevant outcomes to First Mate.
An empty Second-Mate queue is a healthy idle state, not permission to invent work.
Second Mates never create further Second Mates.

Every accepted work item has one durable Task and at least one explicit Assignment before an asynchronous worker begins.
A ship Crewmate works in an isolated worktree until its changes are durably landed or handed off.
A scout's durable output is its report; its scratch worktree may then be discarded.
No Mate merges without the Captain's explicit approval or a previously recorded standing authorization, and no agent or worktree with active or unlanded work is retired by implication.

Delegated agents report through PostgreSQL Inbox, Task and Assignment state rather than opening competing Captain-facing threads.
Direct Captain intervention in any attached terminal remains authoritative and is reconciled into Fleet state.
Each Mate supervises only its direct reports and keeps status changes sparse: decisions, blockers, material phase changes, completion and failure.
While a direct report is active, its Mate keeps exactly one verified harness-appropriate supervision wait and resumes it after handling actionable work.
If the selected release lacks that wake capability, the Mate reports the unsupported boundary instead of claiming unattended supervision.

### Toolchains and worktrees

Mise supplies tools to every AgentOS agent, including First Mates, Second Mates and Crewmates.
The release-owned `mise.toml` and `mise.lock` define Bun, Node and
the pinned Fleet tools for Pi, Codex, Herdr, Treehouse, Kubernetes, GitHub,
validation, AXI helpers and command-line inspection. The pair resolves the
reviewed Bun 1.4.0 canary through Mise's GitHub backend. The moving upstream
`canary` name is resolved through the reviewed Fleet lockfile; an AgentOS
release updates that lock deliberately and verifies a cold locked install on
every released platform before publication.

AgentOS images install that pair as `/etc/mise/config.toml` and
`/etc/mise/mise.lock`, and bake its pinned Bun so typed bootstrap programs do
not require a first-start download. Pods seed the same reviewed pair as
`~/.config/mise/config.toml` and `~/.config/mise/mise.lock` on the agent PVC;
agent-owned additions live separately under `~/.config/mise/conf.d/`.
Before starting a Mate, a direct Mise init step installs the remaining small
startup-critical set: Node, kubectl, Herdr and Pi. A second init step uses
Mise to run the typed home-reconciliation program. Both init containers and the
Mate use one image and one PVC; identical image layers are pulled only once per
node. Remaining released Fleet tools stay
locked and discoverable but are installed explicitly when the running Mate's
task needs them. The Mate image carries only PostgreSQL's official pinned
`postgresql-client-18` package, so agents can invoke `psql` immediately without
compiling or embedding a PostgreSQL server.

Mise itself remains part of the running First Mate, not merely its bootstrap.
Its shims come first on `PATH` for interactive and non-interactive processes, so released tools win over unmanaged global installations.
Agents invoke tools by their ordinary names without a `mise exec` prefix.
Resolution follows the current working directory, including after a Crewmate enters an isolated worktree.
Pinned operating-system transport and database-client utilities in the reviewed
Mate image remain ordinary commands but are not duplicated into the PVC by Mise.

Mise configuration is deliberately layered:

1. `/etc/mise/config.toml` provides the lowest-precedence immutable Fleet baseline.
2. `~/.config/mise/config.toml` carries the same released tool selection on the PVC; its `conf.d/` may add approved persistent tools for that agent.
3. A repository or nested-worktree `mise.toml`, `.tool-versions`, or supported idiomatic version file adds tools and overrides conflicting versions for that project.

A repository with no Mise configuration receives the AgentOS baseline unchanged.
A repository-owned configuration remains project authority; AgentOS does not copy its own project file into foreign worktrees.
Untrusted repository configuration is inspected before trust because Mise configuration may carry executable behavior.
Agents do not install parallel global toolchains through ad hoc npm-global, Homebrew, apt or `curl | sh` paths.

Treehouse owns reusable detached worktrees inside each Crewmate pod. AgentOS
acquires a durable UUID-labelled lease and lets the reviewed Treehouse return
workflow own later cleanup instead of reimplementing worktree pooling.

The Fleet baseline deliberately excludes `tasks-axi` because PostgreSQL is the
task authority, excludes tmux because Herdr is the initial runtime, and excludes
Helm and additional harnesses until implemented behavior requires them.

### Health and recovery

Kubernetes liveness means the pod runtime is technically alive.
An agent waiting for a human, hitting a model limit, or losing provider access must remain attachable and must not be restarted merely to hide the failure.

Readiness may report a required agent as degraded after supported retries classify a provider, quota or rate-limit failure.
Ordinary `blocked` status is not enough to fail readiness.
First or Second Mate inspects Kubernetes and Herdr on demand and decides whether to wait, attach, change model or credentials, restart a process, or take another recovery action.

There are no heartbeats, automatic retry loops or database-maintained liveness
mirrors. A Mate inspects current state and invokes native recovery commands
when its judgment or the Captain requires them.

### PostgreSQL boundary

PostgreSQL is the durable fleet authority for at least:

- agent identities, hierarchy and roles;
- tasks and backlog;
- inbox messages, read state and replies;
- durable status and communication history;
- captain notes and learnings;
- pod and PVC locators;
- schema and release metadata required for safe recovery.

Every agent receives a PostgreSQL identity.
Agents use SQL or `psql` directly; AgentOS does not add a database wrapper service.
First Mate uses the Fleet owner role and is therefore the administrator of the
Fleet database and released AgentOS schema. This does not require PostgreSQL
cluster `SUPERUSER`, `CREATEDB`, `CREATEROLE` or `BYPASSRLS` privileges.
The migration chain runs as that Fleet-owner login, creates or adopts the root
First-Mate row and binds it to the same `session_user`; there is no separate
migrator identity or manual First-Mate mapping. The authorization migration
binds each remaining Agent to an existing,
non-privileged PostgreSQL `session_user` and applies grants plus Row-Level
Security to the Fleet tables. Every active registered Agent receives the same
complete read view with no hidden rows. Writes remain narrower: First Mate can
administer the Fleet, Second Mates their subtrees, and Crewmates themselves;
Inbox content follows sender, recipient and immutability rules. Fleet tables
without a reviewed runtime write policy remain mutable only by First Mate as
owner. The runtime mutation migration lets Mates create and assign Tasks inside
their managed hierarchy and lets assigned Crewmates update only work state.
Completed Assignments are immutable. Retiring an Agent is an explicit function
that refuses active Assignments or active child Agents, so handoff is never an
automatic cascade. Recording hierarchy alone is not authorization, and
migrations never create login credentials.

Messages may be edited by their sender until first read and become immutable afterward; corrections are follow-up messages.
`LISTEN/NOTIFY` may wake an already-running listener but never starts a pod and never replaces the durable inbox row.

One PostgreSQL database is one Fleet. Core tables therefore carry no `fleet_id`; a developer who intentionally needs an isolated second Fleet creates another database. Released objects live in the `agentos` schema. The `local` schema is an approved First-Mate playground whose objects are never treated as released AgentOS behavior until they return through a reviewed migration.

The initial durable model stays deliberately small:

- `captain` stores multiple captain preferences and context entries, never a synthetic singleton Fleet row;
- `agents` stores hierarchy, role and runtime locators, but not Kubernetes or Herdr health;
- `projects` stores non-exclusive work scopes without assigning one permanent owner;
- `tasks` stores accepted durable work, dependencies and its small array of external tracker links;
- `task_assignments` protects active Agent-to-Task relationships and makes completed assignment history immutable;
- `inbox` stores delivery to an Agent: conversation, questions, replies, approvals and notifications. A request is not accepted work until a Task exists;
- `learnings` stores curated, evidence-backed Fleet knowledge;
- `external_events` stores external deliveries and their reconciliation state.

All core rows have immutable identifiers and `created_at` values plus a PostgreSQL-maintained `updated_at`. Status values always carry explanatory status text. Core history is archived or retired rather than hard-deleted, and foreign keys restrict removal while durable relationships remain.

#### External events and reconciliation

External providers are bidirectional human surfaces, not independent fleet authorities and not one-way projections. A GitHub or Linear comment, description edit, status change, assignment or related action is untrusted human intent until a responsible First or Second Mate reconciles it with Fleet state. Provider authentication proves who performed an action and what that account could do in the provider; it does not by itself grant authority over an AgentOS project scope.

Every accepted delivery is appended to `external_events` with the complete provider payload in raw `jsonb`. AgentOS adds only routing and coordination columns such as provider, delivery identifier, event type, actor identifier, coalescing key, batch identifier and reconciliation status. It does not strip or normalize the payload into a lossy internal event format. Agents project only the JSON fields needed by the current SQL query; a GIN index supports containment and JSON-path lookup without loading every payload into model context.

Ingress persists first and never invokes a model directly. Deliveries for the same provider resource share a coalescing key. A short quiet window combines a burst of related actions, while a hard maximum window makes the batch eligible after 30 seconds even if events continue arriving. Exact provider delivery identifiers are idempotent.

Batch coordination also stays in `external_events`; there is no second reconciliation table. A short SQL transaction claims all currently pending rows for one coalescing key with the authenticated Mate's `session_user`, expiry and opaque fencing token, then commits immediately. A caller-supplied Agent ID can never impersonate another Mate. No database lock remains open while a model reasons. Only First and Second Mates may own reconciliation; a cheaper delegated Agent may help inspect a claimed set but cannot complete it.

New events for a claimed key remain durable and pending. Before an external effect or final commit, the owner checks for them and absorbs them into the claim, then re-evaluates from the last successfully reconciled state instead of chasing an obsolete batch. If the owner disappears, the claim expires and another eligible Mate can reclaim every unresolved event with a new token. The former owner is fenced: its old token cannot complete anything. This recovery does not depend on the First Mate remaining alive.

The final local mutation is one short PostgreSQL transaction. It updates all coupled Tasks and Inbox rows and completes the claimed external rows together; a stale token or a newly pending event aborts the whole transaction. Model reasoning and provider commands never run while that transaction is open.

Agents invoke provider tools such as `gh-axi` directly and synchronously instead of writing an AgentOS outbox. They observe the actual exit status and remain responsible for failure and recovery in their persistent harness session. Cross-system atomicity is impossible: after a successful provider command and before the local transaction, a crash can still occur. State-setting provider operations should be idempotent; non-idempotent operations such as comments use a deterministic action identifier when supported. Recovery checks the already persisted webhook payloads first and queries the provider only when local evidence is inconclusive, avoiding routine duplicate API and model work.

The exact tables, indexes, Functions, Triggers, grants, RLS policies and raw-session retention policy are defined only by versioned SQL and SQL tests after schema review.
The `database/` workspace uses Drizzle Kit only to create and
apply journaled custom SQL migrations; it has no Drizzle ORM schema or runtime
database client.
This README does not duplicate them.

PostgreSQL may run at a developer-selected external or managed endpoint or be
self-hosted in the selected cluster. AgentOS treats both as complete paths and
does not rank one ahead of the other. For self-hosting it uses
[CloudNativePG](https://cloudnative-pg.io/) rather than maintaining a raw
PostgreSQL StatefulSet. A compatible existing controller can be reused;
installing or upgrading the cluster-scoped controller requires explicit
approval. When a compatible installed controller is older than the newest
stable release, First Mate presents reuse and upgrade as choices.

The released database manifest is version-neutral. At installation time First
Mate finds the newest stable official CloudNativePG release compatible with the
selected Kubernetes server and the newest stable PostgreSQL operand it supports,
verifies immutable image identities, and shows the exact selection before asking
for approval. It then renders one PostgreSQL instance with a 20 GiB PVC, data
checksums, the unprivileged `agentos` application owner and no network-enabled
superuser. This minimal topology is not HA and has no reviewed backup policy yet.
CNPG generates the application Secret; First Mate uses its `pgpass` entry with
`psql` and injects its URI only into the Drizzle migration process. Pinned
migration dependencies are installed from `bun.lock` into a content-addressed
workspace on the agent PVC when first needed, keeping them out of the runtime
image. Topology does not change schema or security semantics.

### Kubernetes and authorization

Kubernetes owns pod existence, phase, readiness and failure state.
Each workload uses an explicit namespace, ServiceAccount, PVC mapping and immutable AgentOS image reference.

After explicit RBAC approval, the default dedicated-cluster path grants First Mate cluster-administrator access so it can inspect and recover agents.
Shared or sensitive clusters must offer a scoped mode and explain which recovery operations become unavailable.
Workers do not inherit First Mate authority automatically.

Agent runtimes remain ordinary versioned Kubernetes resources; AgentOS does not
introduce its own CRDs or autonomous operator. Only the optional self-hosted
database path uses the external CloudNativePG CRDs and controller.

### Bootstrap

The public README is the human and seed-agent entry point.
A developer gives its short prompt to an existing coding agent without cloning AgentOS first.
That local agent loads `agentos-bootstrap`, inspects read-only, explains viable paths and asks before credentials, login, cost, cluster creation, RBAC or installation.

Bootstrap has two handoff stages:

1. Establish the smallest persistent Kubernetes runtime: Herdr, Pi First Mate, agent PVC, immutable AgentOS release, attach path and working model authentication.
2. Hand control to that First Mate, which selects or provisions PostgreSQL with approval, applies the versioned database assets and verifies the complete fleet identity.

The initial model path uses Pi with the developer's Codex subscription through
provider `openai-codex`. Existing Pi settings on the persistent home remain
authoritative; AgentOS does not seed a release-wide model or thinking level.
Login happens inside the persistent Pi runtime, not by copying a local token directory.
Exact package versions and authentication commands belong to release assets and the auth skill.

The seed resolves the latest published GitHub release, verifies that release is
immutable, and applies only its fixed-name assets under that versioned release
URL. It verifies the immutable AgentOS image digest embedded in the selected
manifest instead of trusting a separate metadata index.
External database dependencies are discovered and verified by First Mate when the developer selects self-hosting.
The default manifest grants First Mate administration within `agentos`;
the separately named dedicated-cluster manifest adds cluster-administrator
access only after explicit approval.

An existing Kubernetes cluster is fully supported.
Akua Zero-to-Cluster is an optional path selected by the developer, never an implicit dependency or contact.

### Skills and agent instructions

Codex and Pi discover `.agents/skills/` directories from their working directory upward to the Git root.
AgentOS uses that hierarchy to keep operational roles out of development sessions:

- `agents/.agents/skills/` contains workflows shared by First and Second Mate, including delegation, supervision, runtime, authentication and database operations;
- `agents/firstmate/.agents/skills/` contains First-Mate-only workflows, including bootstrap, cluster handoff and Second-Mate lifecycle;
- `agents/secondmate/.agents/skills/` is reserved for workflows that are genuinely specific to a Second Mate;
- a future subtree under `apps/` or `packages/` may add its own `.agents/skills/` when development there needs a reusable workflow.

Bootstrap explicitly loads the other skills when it reaches their boundary.
First and Second Mates can load those skills independently during normal operation, so runtime knowledge is not hidden behind bootstrap.
The public README points at root `BOOTSTRAP.md`, a stable and clickable entrypoint that forwards the agent to the canonical nested bootstrap skill.
This is a regular Markdown pointer rather than a symlink because raw GitHub content must remain useful to an agent fetching the file directly.

There is initially no root `.agents/skills/` directory.
Only a workflow that genuinely applies to agent operation and repository development belongs there later.
Sibling skill trees are not linked: a process started under `agents/firstmate/`
sees the shared Fleet skills and its First-Mate skills, while contributor
processes under `database/` or `runtime/` do not see either role tree. Released shared skills
are reconciled into each Agent's persistent home for use from foreign project
worktrees.

The repository deliberately has no root `AGENTS.md`. Contributor
instructions live at the database, runtime and test boundaries they govern;
Agent-shared instructions live under `agents/`; and persistent role
instructions live in two real agent working directories:

- `agents/firstmate/AGENTS.md` is the complete First-Mate job description;
- `agents/secondmate/AGENTS.md` is the complete Second-Mate job description.

The First Mate process starts with `agents/firstmate/` as its working directory; the Second Mate process starts in `agents/secondmate/`.
Codex and Pi can therefore load the selected nested instruction file without mixing both roles, while Pi still discovers the shared `.agents/skills/` directory from an ancestor up to the Git root.
Role-specific Pi configuration may live beside each persistent role under `agents/<role>/.pi/`.

Crewmates are different: their harness working directory is the isolated
project worktree. The owning Mate renders a durable brief from
`agents/crewmate/BRIEF.md`; the project's own `AGENTS.md` then supplies codebase
instructions without becoming the Fleet role contract.

### Repository layout

The repository root is both the AgentOS product surface and its Bun workspace:

- `agents/` contains role working directories, role instructions and operational skills;
- `database/` is the SQL-first Drizzle Kit migration workspace shared by the whole Fleet;
- `runtime/` contains role-neutral image lifecycle mechanics and shared Kubernetes resources;
- subtree-local `.agents/skills/` directories contain scoped, progressively disclosed workflows.

The shared executable Mate lifecycle and common First/Second-Mate StatefulSet
live under `runtime/`; this is not an agent role, external CLI or generic
importable runtime package. Each role owns its Kubernetes patch and surrounding
ServiceAccount, Service, credentials and authority under
`agents/<role>/kubernetes/`. First Mate owns database topology under its
Kubernetes subtree, while `database/` owns schema semantics for every Mate.

There is no speculative CLI or placeholder application. When a real executable
service or reusable library exists, it may introduce `apps/<name>/` or
`packages/<name>/` through a reviewed boundary. The workspace keeps one
`bun.lock`.

### Repository source-of-truth rules

- `README.md` contains product orientation, the copyable onboarding prompt and the canonical architecture.
- `CONTRIBUTING.md` contains repository setup, development conventions and disposable-cluster smoke testing.
- `BOOTSTRAP.md` points to the canonical First-Mate bootstrap skill without duplicating its procedure.
- The Architecture section in this README contains architectural decisions and boundaries.
- `agents/AGENTS.md` contains identity-neutral shared Agent rules.
- `agents/.agents/skills/` contains workflows shared by First and Second Mate without exposing them to contributor or runtime-development sessions.
- `agents/firstmate/` and `agents/secondmate/` contain the two persistent role instruction surfaces, their Pi configuration and role-scoped skills.
- `agents/crewmate/BRIEF.md` is the canonical bounded-worker contract rendered into each Assignment brief.
- `database/AGENTS.md` governs SQL-first schema development without selecting an Agent role.
- `runtime/AGENTS.md` governs shared container lifecycle mechanics without selecting an Agent role.
- `runtime/kubernetes/base/` owns the shared First/Second-Mate StatefulSet.
- `agents/firstmate/kubernetes/`, `agents/secondmate/kubernetes/` and
  `agents/crewmate/kubernetes/` are authoritative for role-owned Kubernetes
  patches and surrounding resources.
- `agents/firstmate/kubernetes/database/` is authoritative for the optional
  self-hosted CloudNativePG topology; it does not own SQL schema.
- `agents/firstmate/kubernetes/release/` is authoritative for immutable
  First-Mate and database release rendering; generated release manifests
  belong only to immutable GitHub releases.
- `runtime/` owns only the common persistent-Mate runtime mechanics,
  StatefulSet base and role-neutral `agentos` image.
- `database/migrations/` and its Drizzle migration journal are authoritative for database semantics, security and applied order; `database/drizzle.tooling.ts` is deliberately empty and non-authoritative.
- Release assets pin exact versions, digests and checksums.
- `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_SOURCES.md` are authoritative for redistributed third-party licensing and source offers.

When documentation and executable assets disagree, stop and reconcile them; do not invent missing production mechanics from prose.

### Herdr distribution boundary

AgentOS remains MIT licensed.
Herdr remains a separate AGPL-3.0-or-later or commercially licensed program.
The open-source distribution path uses an unmodified, pinned Herdr executable through documented CLI and socket interfaces and ships the corresponding license, notice and source offer.
Patching, linking, embedding Herdr source, or otherwise tightening that boundary requires a fresh license review before publication.

### Deliberate exclusions

AgentOS does not introduce autonomous schedulers, heartbeat infrastructure,
AgentOS-specific Kubernetes CRDs or operators, a PostgreSQL wrapper API,
task-specific PVCs, mandatory semantic indexing, or compatibility with the
failed predecessor implementation.

## License

AgentOS is MIT licensed. Redistributed third-party programs retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`THIRD_PARTY_SOURCES.md`](./THIRD_PARTY_SOURCES.md).
