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
> AgentOS is under active development. This repository now includes the first persistent First-Mate runtime slice alongside the architecture, bootstrap workflow, fleet database, toolchain and initial AXI CLI; it is not yet a finished production distribution.

## Develop

The repository is a Bun monorepo whose toolchain is pinned through Mise:

```sh
mise install
bun test
bun run agentos --help
```

Bun reports the release-selected `1.4.0` baseline. Package-specific instructions live with the package they govern.
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
The default is one agent per runtime pod.
Trusted agents may be co-located deliberately; the pod then mounts a separate home for each agent, while sharing a wider security boundary.

First and Second Mates use a small common baseline image and keep ordinary tool
additions in their Mise-managed homes. Crewmates instead receive a task-suited
image selected by the responsible Mate. The judgment-based dispatch profile
may add an optional `image` beside `harness`, `model` and `effort`; omission uses
the released lightweight default, while a remote image must come from an
approved registry and be pinned by digest. Large language- or Codex-oriented
images are therefore explicit task costs, not the universal fleet runtime.

One Herdr server runs per runtime pod and owns that pod's workspaces, tabs, panes, terminal processes, runtime status and native harness session references.
Client detach leaves processes running. After a pod replacement, Herdr restores its layout and asks supported harnesses to resume from their own persistent sessions.

Herdr is not a fleet database.
Its CLI and socket API are used locally for attach, read, send, wait, layout and debugging.
`agentos attach <agent>` will resolve the agent's pod locator and open the real Herdr terminal through an explicit Kubernetes context and namespace.

A First Mate may arrange central fleet workspaces whose panes attach to Herdr sessions in other pods through Kubernetes exec.
This is a user-facing view, not a central controller or a new source of truth.

### Toolchains and worktrees

Mise supplies tools to every AgentOS agent, including First Mates, Second Mates and Crewmates.
The release-owned root `mise.toml`/`mise.lock` own Bun and Node; `agents/mise.toml`/`agents/mise.lock` add pinned Fleet tools for Pi, Herdr, Kubernetes, GitHub, validation, AXI helpers and command-line inspection.
Until Bun 1.4 has a stable release, the root pair resolves the official Bun Canary through Mise's GitHub backend and requires the runtime to report `1.4.0`. Refreshing that moving release is an explicit reviewed update.

Agent Pods install the root pair as `/etc/mise/config.toml` and `/etc/mise/mise.lock`.
They seed the Fleet pair as `~/.config/mise/config.toml` and `~/.config/mise/mise.lock` on the agent PVC; agent-owned additions live separately under `~/.config/mise/conf.d/`.
Before starting a Mate, a direct Mise init step installs the small
startup-critical set: Node, Bun, kubectl, Herdr and Pi. A second init step uses
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

1. `/etc/mise/config.toml` provides the lowest-precedence AgentOS release baseline.
2. `~/.config/mise/config.toml` provides released Fleet tools; its `conf.d/` may add approved persistent tools for that agent.
3. A repository or nested-worktree `mise.toml`, `.tool-versions`, or supported idiomatic version file adds tools and overrides conflicting versions for that project.

A repository with no Mise configuration receives the AgentOS baseline unchanged.
A repository-owned configuration remains project authority; AgentOS does not copy its own project file into foreign worktrees.
Untrusted repository configuration is inspected before trust because Mise configuration may carry executable behavior.
Agents do not install parallel global toolchains through ad hoc npm-global, Homebrew, apt or `curl | sh` paths.

The Fleet baseline deliberately excludes `tasks-axi` because PostgreSQL is the task authority, excludes tmux and treehouse because Herdr is the initial runtime, and excludes Helm and additional harnesses until implemented behavior requires them.

### Health and recovery

Kubernetes liveness means the pod runtime is technically alive.
An agent waiting for a human, hitting a model limit, or losing provider access must remain attachable and must not be restarted merely to hide the failure.

Readiness may report a required agent as degraded after supported retries classify a provider, quota or rate-limit failure.
Ordinary `blocked` status is not enough to fail readiness.
First or Second Mate inspects Kubernetes and Herdr on demand and decides whether to wait, attach, change model or credentials, restart a process, or take another recovery action.

There are no heartbeats, autonomous pod-start controllers, automatic recovery policies, or database-maintained liveness mirrors.

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
Before mutually untrusted Agent identities share a Fleet database, a reviewed security migration must bind those identities to grants and Row-Level Security: First Mate manages the Fleet, Second Mates their subtrees, and Crewmates their own mutable records while retaining the approved Fleet read view. Recording hierarchy in the initial tables is not itself authorization.

Messages may be edited by their sender until first read and become immutable afterward; corrections are follow-up messages.
`LISTEN/NOTIFY` may wake an already-running listener but never starts a pod and never replaces the durable inbox row.

One PostgreSQL database is one Fleet. Core tables therefore carry no `fleet_id`; a developer who intentionally needs an isolated second Fleet creates another database. Released objects live in the `agentos` schema. The `local` schema is an approved First-Mate playground whose objects are never treated as released AgentOS behavior until they return through a reviewed migration.

The initial durable model stays deliberately small:

- `captain` stores multiple captain preferences and context entries, never a synthetic singleton Fleet row;
- `agents` stores hierarchy, role and runtime locators, but not Kubernetes or Herdr health;
- `projects` stores non-exclusive work scopes without assigning one permanent owner;
- `tasks` stores accepted durable work, dependencies and its small array of external tracker links;
- `task_assignments` protects active Agent-to-Task relationships and preserves assignment history;
- `inbox` stores delivery to an Agent: conversation, questions, replies, approvals and notifications. A request is not accepted work until a Task exists;
- `learnings` stores curated, evidence-backed Fleet knowledge;
- `external_events` stores external deliveries and their reconciliation state.

All core rows have immutable identifiers and `created_at` values plus a PostgreSQL-maintained `updated_at`. Status values always carry explanatory status text. Core history is archived or retired rather than hard-deleted, and foreign keys restrict removal while durable relationships remain.

#### External events and reconciliation

External providers are bidirectional human surfaces, not independent fleet authorities and not one-way projections. A GitHub or Linear comment, description edit, status change, assignment or related action is untrusted human intent until a responsible First or Second Mate reconciles it with Fleet state. Provider authentication proves who performed an action and what that account could do in the provider; it does not by itself grant authority over an AgentOS project scope.

Every accepted delivery is appended to `external_events` with the complete provider payload in raw `jsonb`. AgentOS adds only routing and coordination columns such as provider, delivery identifier, event type, actor identifier, coalescing key, batch identifier and reconciliation status. It does not strip or normalize the payload into a lossy internal event format. Agents project only the JSON fields needed by the current SQL query; a GIN index supports containment and JSON-path lookup without loading every payload into model context.

Ingress persists first and never invokes a model directly. Deliveries for the same provider resource share a coalescing key. A short quiet window combines a burst of related actions, while a hard maximum window makes the batch eligible after 30 seconds even if events continue arriving. Exact provider delivery identifiers are idempotent.

Batch coordination also stays in `external_events`; there is no second reconciliation table. A short SQL transaction claims all currently pending rows for one coalescing key with an Agent identity, expiry and opaque fencing token, then commits immediately. No database lock remains open while a model reasons. Only First and Second Mates may own reconciliation; a cheaper delegated Agent may help inspect a claimed set but cannot complete it.

New events for a claimed key remain durable and pending. Before an external effect or final commit, the owner checks for them and absorbs them into the claim, then re-evaluates from the last successfully reconciled state instead of chasing an obsolete batch. If the owner disappears, the claim expires and another eligible Mate can reclaim every unresolved event with a new token. The former owner is fenced: its old token cannot complete anything. This recovery does not depend on the First Mate remaining alive.

The final local mutation is one short PostgreSQL transaction. It updates all coupled Tasks and Inbox rows and completes the claimed external rows together; a stale token or a newly pending event aborts the whole transaction. Model reasoning and provider commands never run while that transaction is open.

Agents invoke provider tools such as `gh-axi` directly and synchronously instead of writing an AgentOS outbox. They observe the actual exit status and remain responsible for failure and recovery in their persistent harness session. Cross-system atomicity is impossible: after a successful provider command and before the local transaction, a crash can still occur. State-setting provider operations should be idempotent; non-idempotent operations such as comments use a deterministic action identifier when supported. Recovery checks the already persisted webhook payloads first and queries the provider only when local evidence is inconclusive, avoiding routine duplicate API and model work.

The exact tables, indexes, Functions, Triggers, grants, RLS policies and raw-session retention policy are defined only by versioned SQL and SQL tests after schema review.
The `packages/database/` workspace uses Drizzle Kit only to create and apply journaled custom SQL migrations; it has no Drizzle ORM schema or runtime database client.
This README does not duplicate them.

PostgreSQL may run in the AgentOS cluster or at a developer-selected external or managed endpoint.
Topology does not change schema or security semantics.

### Kubernetes and authorization

Kubernetes owns pod existence, phase, readiness and failure state.
Each workload uses an explicit namespace, ServiceAccount, PVC mapping and immutable AgentOS image reference.

After explicit RBAC approval, the default dedicated-cluster path grants First Mate cluster-administrator access so it can inspect and recover agents.
Shared or sensitive clusters must offer a scoped mode and explain which recovery operations become unavailable.
Workers do not inherit First Mate authority automatically.

Kubernetes resources are ordinary versioned manifests; AgentOS does not require CRDs or an autonomous operator.

### Agent-facing CLI

The `agentos` command is an Agent Experience Interface (AXI), not a model-driven orchestrator.
It exposes deterministic fleet primitives with token-efficient structured output, explicit empty states, bounded content, structured failures, idempotent mutations and contextual next-command hints.
Running it without arguments returns a compact live home view; each command also provides concise help.

The initial TypeScript implementation uses the pinned `axi-sdk-js` library for shared dispatch, TOON serialization and error behavior.
AgentOS owns its `update` command so upgrades remain bound to reviewed immutable AgentOS releases rather than a package-manager global self-update.
AXI session hooks remain opt-in and harness-specific; unsupported Pi lifecycle integration is implemented through the reviewed Pi extension path rather than assumed from the SDK.

### Bootstrap

The public README is the human and seed-agent entry point.
A developer gives its short prompt to an existing coding agent without cloning AgentOS first.
That local agent loads `agentos-bootstrap`, inspects read-only, explains viable paths and asks before credentials, login, cost, cluster creation, RBAC or installation.

Bootstrap has two handoff stages:

1. Establish the smallest persistent Kubernetes runtime: Herdr, Pi First Mate, agent PVC, immutable AgentOS release, attach path and working model authentication.
2. Hand control to that First Mate, which selects or provisions PostgreSQL with approval, applies the versioned database assets and verifies the complete fleet identity.

The initial model path uses Pi with the developer's Codex subscription through provider `openai-codex`; the release default is `gpt-5.6-terra` with `high` thinking.
Login happens inside the persistent Pi runtime, not by copying a local token directory.
Exact package versions and authentication commands belong to release assets and the auth skill.

The seed resolves `release.json` through the latest published GitHub release,
verifies that release is immutable, and applies only its versioned manifest
URL. The default manifest grants First Mate administration within `agentos`;
the separately named dedicated-cluster manifest adds cluster-administrator
access only after explicit approval.

An existing Kubernetes cluster is fully supported.
Akua Zero-to-Cluster is an optional path selected by the developer, never an implicit dependency or contact.

### Skills and agent instructions

Codex and Pi discover `.agents/skills/` directories from their working directory upward to the Git root.
AgentOS uses that hierarchy to keep operational roles out of development sessions:

- `agents/.agents/skills/` contains workflows shared by First and Second Mate, initially runtime, authentication and database operations;
- `agents/firstmate/.agents/skills/` contains First-Mate-only workflows, initially bootstrap and cluster handoff;
- `agents/secondmate/.agents/skills/` is reserved for workflows that are genuinely specific to a Second Mate;
- a subtree under `apps/` or `packages/` may add its own `.agents/skills/` when development there needs a reusable workflow.

Bootstrap explicitly loads the other skills when it reaches their boundary.
First and Second Mates can load those skills independently during normal operation, so runtime knowledge is not hidden behind bootstrap.
The public README points at root `BOOTSTRAP.md`, a stable and clickable entrypoint that forwards the agent to the canonical nested bootstrap skill.
This is a regular Markdown pointer rather than a symlink because raw GitHub content must remain useful to an agent fetching the file directly.

There is initially no root `.agents/skills/` directory.
Only a workflow that genuinely applies to agent operation and repository development belongs there later.
Sibling skill trees are not copied or linked: a process started under `agents/firstmate/` sees the shared `agents/` skills and its First-Mate skills, while a process under `apps/` or `packages/` does not see either agent-role tree.

The repository deliberately has no root `AGENTS.md`.
Role instructions live in two real agent working directories:

- `agents/firstmate/AGENTS.md` is the complete First-Mate job description;
- `agents/secondmate/AGENTS.md` is the complete Second-Mate job description.

The First Mate process starts with `agents/firstmate/` as its working directory; the Second Mate process starts in `agents/secondmate/`.
Codex and Pi can therefore load the selected nested instruction file without mixing both roles, while Pi still discovers the shared `.agents/skills/` directory from an ancestor up to the Git root.
Role-specific Pi configuration may live beside each role under `agents/<role>/.pi/`.

The visible `agents/` directories define AgentOS product roles and their working directories; nested `.agents/` directories follow the cross-client Agent Skills convention.
Agent role directories are Bun workspaces only when they contain executable TypeScript; Markdown and Pi configuration alone do not justify a package boundary.

### Repository layout

The Bun monorepo separates executable entrypoints, importable code and agent roles:

- `apps/` contains everything launched directly as a process or binary;
- `packages/` contains importable TypeScript packages without process entrypoints;
- `agents/` contains agent working directories and declarative role configuration;
- `packages/database/` is the SQL-first Drizzle Kit migration workspace;
- subtree-local `.agents/skills/` directories contain scoped, progressively disclosed workflows.

The initial executable is `apps/agentos/`, a deliberately thin CLI entrypoint that imports command behavior from `packages/cli/`.
There is no generic runtime package before shared runtime code actually exists; reusable implementation receives a concrete package when it has a real consumer.
Future executable services receive their own directory under `apps/`; reusable implementation belongs in `packages/` instead of being duplicated between apps or roles.

The root `package.json` declares `apps/*` and `packages/*` as Bun workspaces.
Workspace packages depend on each other through `workspace:*`, and the repository keeps one root `bun.lock`.

### Repository source-of-truth rules

- `README.md` contains product orientation, the copyable onboarding prompt and the canonical architecture.
- `CONTRIBUTING.md` contains repository setup, development conventions and disposable-cluster smoke testing.
- `BOOTSTRAP.md` points to the canonical First-Mate bootstrap skill without duplicating its procedure.
- The Architecture section in this README contains architectural decisions and boundaries.
- `agents/.agents/skills/` contains workflows shared by First and Second Mate without exposing them to development sessions.
- `agents/firstmate/` and `agents/secondmate/` contain the two role instruction surfaces, their Pi configuration and role-scoped skills.
- `apps/` contains executable entrypoints; `packages/` contains their importable implementation.
- `deploy/kubernetes/` is authoritative for rendered Kubernetes resources.
- `deploy/kubernetes/firstmate/release/` is authoritative for the renderer;
  generated manifests and `release.json` belong only to immutable GitHub releases.
- `packages/database/migrations/` and its Drizzle migration journal are authoritative for database semantics, security and applied order; `packages/database/drizzle.tooling.ts` is deliberately empty and non-authoritative.
- `apps/agentos/`, `packages/cli/`, CLI output and their tests define implemented AXI behavior.
- Release assets pin exact versions, digests and checksums.
- `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_SOURCES.md` are authoritative for redistributed third-party licensing and source offers.

When documentation and executable assets disagree, stop and reconcile them; do not invent missing production mechanics from prose.

### Herdr distribution boundary

AgentOS remains MIT licensed.
Herdr remains a separate AGPL-3.0-or-later or commercially licensed program.
The open-source distribution path uses an unmodified, pinned Herdr executable through documented CLI and socket interfaces and ships the corresponding license, notice and source offer.
Patching, linking, embedding Herdr source, or otherwise tightening that boundary requires a fresh license review before publication.

### Deliberate exclusions

AgentOS does not introduce autonomous schedulers, heartbeat infrastructure, Kubernetes CRDs, a PostgreSQL wrapper API, task-specific PVCs, mandatory semantic indexing, or compatibility with the failed predecessor implementation.

## License

AgentOS is MIT licensed. Redistributed third-party programs retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`THIRD_PARTY_SOURCES.md`](./THIRD_PARTY_SOURCES.md).
