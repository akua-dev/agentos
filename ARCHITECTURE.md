# AgentOS architecture

AgentOS is an agent-native fleet system for persistent coding agents in Kubernetes.
The model remains the decision-maker; repository code implements only deterministic, reviewable mechanics.

AgentOS occupies the layer above the agent harness: a harness such as Pi turns
a model into an agent, and AgentOS turns agents into an organization. Its
canonical coordination primitive is the Assignment — one outcome bound to one
accountable Agent. The remaining durable model exists to keep Assignments
truthful.

## System boundaries

Each kind of state has one authority:

| Concern | Authority |
| --- | --- |
| Human planning and provider workflow | Captain-selected tracker or provider |
| Durable fleet data | PostgreSQL |
| Live workload state | Kubernetes |
| Terminal and harness runtime | Herdr inside each runtime pod |
| Agent home and unfinished work | Agent-owned PVC |
| Delivered code | Git and its remote |
| Optional pooled AI credentials and routing state | Quota-router PVC and process |

AgentOS does not continuously mirror one authority into another.
PostgreSQL stores pod locators, not heartbeats; Kubernetes is inspected when live state matters.
Terminal output stays in the runtime unless a deliberate workflow archives a specific artifact.

### Chain of custody

AgentOS connects these authorities without turning any one of them into a
universal ledger. A provider issue, board change or comment records human
planning and external workflow state. A responsible Mate reconciles that intent;
accepted work receives one PostgreSQL Task and at least one accountable
Assignment. Raw model reasoning, harness transcripts and terminal output remain
in their runtime authorities. Delivered changes become durable only in Git and
its remote, after which the responsible Agent reconciles the human tracker
through its native provider tool.

Stable references join the chain: a Task may carry external tracker links, its
Assignment history records ownership and handoff, and its report identifies the
delivered result. AgentOS does not continuously mirror issue bodies, transcripts
or repositories into PostgreSQL merely to make querying convenient.

PostgreSQL is therefore the enforceable coordination ledger, not a claim that
every thought or mutation is a forensic audit event. Versioned SQL defines the
specific guarantees AgentOS can promise: authenticated identity, scoped writes,
atomic handoff, durable Captain decisions, selected immutable history and
transactional wake hints. Core owns guarantees; integrations own workflows and
surfaces.

### Evaluation boundary

Benchmark evidence is a bounded, immutable derivative of the authorities
above, never another Fleet authority, transcript mirror or analytics table in
the coordination database. A scenario declares which events and stable
references it needs; unavailable telemetry remains `unobserved`. Measurement
does not mutate the subject, and improvement begins only after the evidence is
frozen. The portable contracts and AgentOS evidence mapping live under
[`benchmarks/`](./benchmarks/README.md).

## Agents and runtime pods

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
directory, environment, lifecycle tasks and credentials. The image contains a
credential-free, shallow Git seed at its exact source revision, Mise, pinned
Bun and the locked AgentOS
tool definitions. First start clones that seed to the home PVC and Pi runs from
the persistent role directory; an init container
installs Node and the remaining startup-critical Fleet tools onto the Mate's persistent home.
Ordinary tool additions remain in that Mise-managed home. Crewmates instead
receive a task-suited image selected by the responsible Mate. The judgment-based
dispatch profile
may add an optional `image` beside `harness`, `model` and `effort`; omission uses
the released lightweight default, while a remote image must come from an
approved registry and be pinned by digest. Large language- or Codex-oriented
images are therefore explicit task costs, not the universal fleet runtime.
Read-heavy Scouts may opt into a separate ArtifactFS image and a reviewed
platform-specific FUSE Pod profile for fast lazy access to large or multiple
repositories. ArtifactFS is never installed in the common Mate image, and its
scratch overlay is not a delivery path for ship work.

One Herdr server runs per runtime pod and owns that pod's workspaces, tabs, panes, terminal processes, runtime status and native harness session references.
Client detach leaves processes running. After a pod replacement, Herdr restores its layout and asks supported harnesses to resume from their own persistent sessions.

Herdr is not a fleet database.
Its CLI and socket API are used locally for attach, read, send, wait, layout and debugging.
AgentOS uses Herdr's documented CLI for one-shot supervision waits; those
commands already resolve targets and wait through the public socket protocol,
so AgentOS ships no parallel Herdr client. A future long-lived subscriber must
first justify why the CLI wait surface is insufficient, negotiate the installed
protocol/schema, bootstrap from `session.snapshot`, and take a fresh snapshot
after every reconnect before trusting subsequent events.
Outside the cluster, a human or seed agent resolves the target Pod with native
`kubectl` using an explicit Kubernetes context, enters that Pod, and invokes
its real Herdr terminal. A running Mate first distinguishes its current
cluster, namespace, Pod, container and identity from the intended target. It
invokes a native command directly when it already occupies that execution
boundary, and uses `kubectl` with its in-cluster credentials when the target is
another Kubernetes boundary. Neither direct execution nor `kubectl exec` is a
universal rule.

A First Mate may arrange central fleet workspaces whose panes attach to Herdr sessions in other pods through Kubernetes exec.
This is only a user-facing view; the remote pod-local sessions remain authoritative.

## Delegation and supervision

The Captain has one regular fleet interface: First Mate.
First Mate does not perform project-specific coding, investigation, planning, bug reproduction or audits itself.
It may inspect projects read-only to understand and route work, and it may mutate reviewed Fleet operational state, but it delegates project work to a charter-matched Second Mate or a bounded Crewmate.
A persistent writable AgentOS development checkout is First Mate's narrow self-maintenance exception: it may change shared AgentOS source directly only with Captain approval, no active direct report and the normal reviewed delivery path.
The root-owned `/opt/agentos` tree is the immutable image Git seed, not the
active checkout. The harness reads AgentOS instructions, Skills and Mise files
from `$HOME/projects/agentos`; unfinished changes and its worktrees therefore
survive Pod replacement. Reviewed Markdown and Skill updates can be loaded from
that Git checkout at a safe Pi turn boundary, while OS, runtime and Kubernetes
changes still reach a running Mate through a tested immutable image digest.
If any direct report is active, First Mate delegates AgentOS source changes too because hands-on work competes with supervision.

A Second Mate uses the same architecture inside one persistent charter.
It delegates project work to its own Crewmates, manages only its direct subtree and returns Captain-relevant outcomes to First Mate.
An empty Second-Mate queue is a healthy idle state, not permission to invent work.
Second Mates never create further Second Mates.

Every accepted work item has one durable Task and at least one explicit Assignment before an asynchronous worker begins.
A Task keeps one stable identity across handoff. Each Assignment stores its
complete authoritative brief, resolved harness profile and final or handoff
report; its PVC copy is only the harness view. A handoff ends the prior
Assignment and creates the replacement atomically instead of rewriting history
or cloning the Task.
A ship Crewmate works in an isolated worktree until its changes are durably landed or handed off.
A ship is complete only when the selected project workflow has produced its
declared durable delivery artifact: a remote-backed workflow normally commits
and pushes the task branch and creates or updates its review artifact, while a
local-only workflow produces a clean committed branch. Accepted ship authority
never includes a default-branch push or merge. A contradictory brief that
forbids every selected delivery path is rejected or reclassified before
dispatch; an uncommitted worktree is not review-ready.
A scout's durable output is its report; its scratch worktree or ArtifactFS mount may then be discarded.
No Mate merges without the Captain's explicit approval or a previously recorded standing authorization, and no agent or workspace with active or unlanded work is retired by implication.

Task and Assignment state is the primary channel for delegated work. Inbox is
reserved for durable speech acts that state cannot express, and Agent-authored
delivery crosses only one direct parent-child hierarchy edge. A cross-domain
request escalates to the common ancestor, which creates or routes a Task in the
target subtree; sibling Agents never establish a lateral coordination channel.
Persistent First and Second Mates wake through PostgreSQL `LISTEN/NOTIFY` and
query the durable rows. Crewmates are not required to run AgentOS supervision
or a PostgreSQL listener: for a downward Crewmate delivery, the owning Mate
commits the Inbox row first, then submits one concise Herdr doorbell containing
only its kind, UUID and subject. The full body is never duplicated into the
terminal. A visible supervisor label followed by U+2063 distinguishes this
ephemeral routing hint from likely direct human input, but never authenticates
it or grants authority. Direct terminal delivery to another Mate is an
exceptional recovery path for a broken listener, not ordinary communication.
Direct Captain intervention in any attached terminal remains authoritative and is reconciled into Fleet state.
Fleet-wide and Mate-domain Captain preferences are scoped rows in one readable
table rather than synchronized files. Genuine unresolved Captain choices live
in Inbox under stable keys. Investigations attest their complete choice set,
including none, before completion; the exact answer later releases linked Task
dependencies atomically without a separate decisions service.
That idempotent transaction—record the response, close the speech act and apply
its coupled state effect—is the template for any future Inbox act that changes
durable state.
Each Mate supervises only its direct reports and keeps status changes sparse: decisions, blockers, material phase changes, completion and failure.
While direct reports are active, their Mate keeps the smallest verified set of
situation-appropriate waits: normally one durable Fleet notification wait plus
native Kubernetes, Herdr-status or bounded terminal waits for concrete live
risks. Waits are deduplicated by authority, target and predicate and re-armed
only while their condition remains useful.
If the selected release lacks that wake capability, the Mate reports the unsupported boundary instead of claiming unattended supervision.

Project checkouts and provider repositories are operated through native Git and
reviewed provider CLIs. The project's selected delivery workflow owns its
validation, task-branch push, review artifact and approval rigor; AgentOS does
not add a wrapper CLI or a parallel review gate. Project metadata records that
workflow, artifact and merge authority as durable prose rather than an AgentOS
mode enum. The Task links the resulting remote review artifact and the
Assignment report records branch, commit, URL, validation and delivery state.
External webhook payloads remain immutable JSON, coalesce into
short bounded bursts and are reconciled pull-first by the responsible Mate.
Provider writes remain synchronous and visible to that Agent rather than being
hidden behind an outbox worker.

Provider identity stays at the same native boundary. An individual may keep
native `gh` authentication on the owning Mate's PVC. A team may instead mount a
dedicated GitHub App private key into First Mate only and mint short-lived
installation tokens on demand for native `git`, `gh-axi` and `gh` calls. The
key never enters Agent home, Fleet rows, child Agents or source control, and no
long-lived token is cached. Repository permissions are a Captain-reviewed
provider boundary, not Fleet authority; the accepted delivery workflow still
controls which write or merge is allowed.

## Toolchains and worktrees

Mise supplies tools to every AgentOS agent, including First Mates, Second Mates and Crewmates.
The release-owned `mise.toml` and `mise.lock` define Bun, Node and
the pinned Fleet tools for Pi, Codex, Herdr, Treehouse, Kubernetes, GitHub,
validation, AXI helpers and command-line inspection. The pair resolves exact
Bun revision `1.4.0-canary.1+3979cbe80` through Mise's checksummed HTTP backend. Because
upstream's moving `canary` release deletes superseded assets, every Bun
platform entry in the reviewed lock uses its upstream checksum and a direct
URL to an immutable AgentOS toolchain prerelease containing the unmodified
archive plus license and source/relink notices. A stable Bun 1.4 release
supersedes this temporary mirror once available.

AgentOS images install that pair as `/etc/mise/config.toml` and
`/etc/mise/mise.lock`, and bake its pinned Bun so typed bootstrap programs do
not require a first-start download. The persistent AgentOS Git checkout
provides the current repository and role Mise configuration; agent-owned
additions live separately under `~/.config/mise/conf.d/`.
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

1. `/etc/mise/config.toml` provides the lowest-precedence immutable image baseline.
2. The persistent AgentOS checkout supplies its reviewed root and role configuration; `~/.config/mise/conf.d/` may add approved persistent tools for that agent.
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

## Optional pooled AI capacity

Direct provider authentication inside each Agent's persistent harness is a
complete AgentOS topology and remains the default. A Captain may instead select
the optional Fleet quota router when several approved Agents should share a
pool of Codex subscriptions. That service is capacity infrastructure, not the
Fleet coordination kernel: PostgreSQL still owns work and communication, the
harness still chooses the requested provider/model, and the provider response
still returns synchronously to the calling harness.

The first implementation is a single-replica Bun service with one retained
ReadWriteOnce PVC. Its mode-`0600` OAuth vault owns fresh server-created Codex
refresh chains; its separate routing state owns only bounded quota observations,
opaque session assignments, provider blocks and renewable request reservations.
It stores no prompts, model responses or harness transcripts. An OpenAI API key
may be mounted separately as an explicitly enabled last-resort fallback and is
never copied into the mutable OAuth vault.

Every client request is authenticated before its body is read. Selected Agent
Pods receive only a Fleet client token and are also constrained by a
selected-client NetworkPolicy. The router removes inbound credentials, selects
and reserves an eligible account, normalizes the OpenAI Responses path, injects
that account's upstream credential and streams the actual response. Existing
sessions remain sticky while eligible. A sent request is never retried silently
on another account; upstream `401`, `429`, timeout and provider failures remain
visible to Pi or Codex and affect only later selection.

Pi exposes the router as the explicit `fleet-codex` provider through a
role-local extension that is inert without its two environment values. Codex
uses native `model_providers` configuration, not an AgentOS wrapper. Neither
path selects a model or rewrites a persistent default. `quota-axi` remains an
observation-only tool and has no routing, login or mutation authority.

The released service, tests and optional Kubernetes topology live together in
`services/quota-router/`. First Mate may operate that topology through its
reviewed Skill and RBAC without owning the component's source directory.
Claude, Gemini, WebSockets,
multi-replica authority, public ingress and general-purpose AI gateway behavior
remain outside the first contract.

## Health and recovery

Kubernetes liveness means the pod runtime is technically alive.
An agent waiting for a human, hitting a model limit, or losing provider access must remain attachable and must not be restarted merely to hide the failure.

Readiness may report a required agent as degraded after supported retries classify a provider, quota or rate-limit failure.
Ordinary `blocked` status is not enough to fail readiness.
First or Second Mate inspects Kubernetes and Herdr on demand and decides whether to wait, attach, change model or credentials, restart a process, or take another recovery action.

There are no heartbeats, automatic retry loops or database-maintained liveness
mirrors. A Mate inspects current state and invokes native recovery commands
when its judgment or the Captain requires them.

## PostgreSQL boundary

PostgreSQL is the durable fleet authority for at least:

- agent identities, hierarchy and roles;
- tasks and backlog;
- inbox requests, questions, decisions, replies and read state;
- durable status, handoff and coordination history;
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
Agent-authored Inbox delivery requires an authentic sender and a direct
parent-child recipient, then content follows sender, recipient and immutability
rules. Fleet tables
without a reviewed runtime write policy remain mutable only by First Mate as
owner. The runtime mutation migration lets Mates create and assign Tasks inside
their managed hierarchy and lets assigned Crewmates update only work state.
Completed Assignments are immutable. Retiring an Agent is an explicit function
that refuses active Assignments or active child Agents, so handoff is never an
automatic cascade. Recording hierarchy alone is not authorization, and
migrations never create login credentials.

Messages may be edited by their sender until first read and become immutable
afterward; corrections are follow-up messages. The recipient calls
`agentos.receive_inbox` to atomically load the row and set `read_at`; First Mate
retains owner-level administrative repair. `read_at` means the delivery entered
the recipient's model context, while `resolved_at` means its requested action or
disposition was durably handled. A read but unresolved row therefore remains
recoverable work after a crash.
Transactional Fleet triggers publish small table-and-operation hints on the
`agentos_events` channel. A running Pi Mate can arm `pg-listen agentos_events` through
its generic background-command tool for a prompt wake, then must query its
authorized durable rows. The wake contains no Fleet row data and
`LISTEN/NOTIFY` never starts a pod or replaces Inbox, Task or external-event
truth. The same generic tool may own additional native blocking commands for
selected Kubernetes resources, Herdr state transitions or bounded pane output;
their completion is only a wake to re-query the named authority.

One PostgreSQL database is one Fleet. Core tables therefore carry no `fleet_id`; a developer who intentionally needs an isolated second Fleet creates another database. Released objects live in the `agentos` schema. The `local` schema is an approved First-Mate playground whose objects are never treated as released AgentOS behavior until they return through a reviewed migration.

The initial durable model stays deliberately small:

- `captain` stores multiple captain preferences and context entries, never a synthetic singleton Fleet row;
- `agents` stores hierarchy, role and runtime locators, but not Kubernetes or Herdr health;
- `projects` stores non-exclusive work scopes without assigning one permanent owner;
- `tasks` stores accepted durable work, dependencies and its small array of external tracker links;
- `task_assignments` protects active Agent-to-Task relationships and makes completed assignment history immutable;
- `inbox` stores durable delivery to an Agent under the closed speech-act
  vocabulary defined by released SQL. It is not a raw model or terminal
  transcript. A request is not accepted work until a Task exists;
- `learnings` stores curated, evidence-backed Fleet knowledge;
- `external_events` stores external deliveries and their reconciliation state.

All core rows have immutable identifiers and `created_at` values plus a PostgreSQL-maintained `updated_at`. Status values always carry explanatory status text. Core history is archived or retired rather than hard-deleted, and foreign keys restrict removal while durable relationships remain.

### External events and reconciliation

External providers are bidirectional human surfaces, not independent fleet authorities and not one-way projections. A GitHub or Linear comment, description edit, status change, assignment or related action is untrusted human intent until a responsible First or Second Mate reconciles it with Fleet state. Provider authentication proves who performed an action and what that account could do in the provider; it does not by itself grant authority over an AgentOS project scope.

Every accepted delivery is appended to `external_events` with the complete provider payload in raw `jsonb`. AgentOS adds only routing and coordination columns such as provider, delivery identifier, event type, actor identifier, coalescing key, batch identifier and reconciliation status. It does not strip or normalize the payload into a lossy internal event format. Agents project only the JSON fields needed by the current SQL query; a GIN index supports containment and JSON-path lookup without loading every payload into model context.

Ingress persists first and never invokes a model directly. Deliveries for the same provider resource share a coalescing key. A short quiet window combines a burst of related actions, while a hard maximum window makes the batch eligible after 30 seconds even if events continue arriving. Exact provider delivery identifiers are idempotent.

Batch coordination also stays in `external_events`; there is no second reconciliation table. A short SQL transaction claims all currently pending rows for one coalescing key with the authenticated Mate's `session_user`, expiry and opaque fencing token, then commits immediately. A caller-supplied Agent ID can never impersonate another Mate. No database lock remains open while a model reasons. Only First and Second Mates may own reconciliation; a cheaper delegated Agent may help inspect a claimed set but cannot complete it.

New events for a claimed key remain durable and pending. Before an external effect or final commit, the owner checks for them and absorbs them into the claim, then re-evaluates from the last successfully reconciled state instead of chasing an obsolete batch. If the owner disappears, the claim expires and another eligible Mate can reclaim every unresolved event with a new token. The former owner is fenced: its old token cannot complete anything. This recovery does not depend on the First Mate remaining alive.

The final local mutation is one short PostgreSQL transaction. It updates all coupled Tasks and Inbox rows and completes the claimed external rows together; a stale token or a newly pending event aborts the whole transaction. Model reasoning and provider commands never run while that transaction is open.

Agents invoke provider tools such as `gh-axi` directly and synchronously instead of writing an AgentOS outbox. They observe the actual exit status and remain responsible for failure and recovery in their persistent harness session. Cross-system atomicity is impossible: after a successful provider command and before the local transaction, a crash can still occur. State-setting provider operations should be idempotent; non-idempotent operations such as comments use a deterministic action identifier when supported. Recovery checks the already persisted webhook payloads first and queries the provider only when local evidence is inconclusive, avoiding routine duplicate API and model work.

The exact tables, indexes, Functions, Triggers, grants, RLS policies, retention
and immutability guarantees are defined only by versioned SQL and SQL tests
after schema review.
The `database/` workspace uses Drizzle Kit only to create and
apply journaled custom SQL migrations; it has no Drizzle ORM schema or runtime
database client.
This document does not duplicate them.

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
image. After CNPG is Ready, one role-owned additive strategic patch wires its
application identity and private CA into the already running First Mate. This
explicit stage-two handoff preserves the selected image and unrelated workload
state, requires approval for the intentional Pod restart, and is not a second
database topology or release manifest. External PostgreSQL receives only an
installation-specific equivalent after its endpoint, TLS and Secret shape are
known. Topology does not change schema or security semantics.

## Kubernetes and authorization

Kubernetes owns pod existence, phase, readiness and failure state.
Each workload uses an explicit namespace, ServiceAccount, PVC mapping and immutable AgentOS image reference.

After explicit RBAC approval, the default dedicated-cluster path grants First Mate cluster-administrator access so it can inspect and recover agents.
Shared or sensitive clusters must offer a scoped mode and explain which recovery operations become unavailable.
Workers do not inherit First Mate authority automatically.

Agent runtimes remain ordinary versioned Kubernetes resources; AgentOS does not
introduce its own CRDs or autonomous operator. Only the optional self-hosted
database path uses the external CloudNativePG CRDs and controller.
The optional quota router is an ordinary single-replica StatefulSet and
ClusterIP Service; it adds no Kubernetes controller or CRD.

## Bootstrap

The public README is the human and seed-agent entry point.
A developer gives its short prompt to an existing coding agent without cloning AgentOS first.
That local agent loads `agentos-bootstrap`, inspects read-only, explains viable paths and asks before credentials, login, cost, cluster creation, RBAC or installation.

Bootstrap has two handoff stages:

1. Establish the smallest persistent Kubernetes runtime: Herdr, Pi First Mate, agent PVC, immutable AgentOS revision, attach path and working model authentication.
2. Hand control to that First Mate, which selects or provisions PostgreSQL with approval, applies the versioned database assets and verifies the complete fleet identity.

Stage one may come online without PostgreSQL so the temporary seed needs fewer
tools and the developer can meet First Mate sooner. That is an incomplete
bootstrap boundary, not an alternate AgentOS operating mode. First Mate may
inspect, explain and finish provisioning, but it must not accept durable work,
create Assignments or delegate a Crewmate until stage two and the released
database security checks pass.

The initial model path uses Pi with the developer's Codex subscription through
provider `openai-codex`. Existing Pi settings on the persistent home remain
authoritative; AgentOS does not seed a release-wide model or thinking level.
Login happens inside the persistent Pi runtime, not by copying a local token directory.
Exact package versions and authentication commands belong to release assets and the auth skill.
Source-provider authentication is a separate choice. Personal native `gh`
login remains complete; teams may select the GitHub App path defined by the
auth Skill, with its private key mounted only into First Mate and short-lived
installation tokens consumed directly by native provider tools.
The optional quota router is not required for either bootstrap stage. It may be
selected later through its dedicated Skill after direct First-Mate auth works.

For a stable install, the seed resolves the latest published GitHub release,
verifies that release is immutable, and applies only its fixed-name assets
under that versioned release URL. An explicitly chosen preview instead uses an
exact Git commit, a locally rendered manifest and an immutable OCI digest; it
never installs from a branch URL or mutable tag.
External database dependencies are discovered and verified by First Mate when the developer selects self-hosting.
The default manifest grants First Mate administration within `agentos`;
the separately named dedicated-cluster manifest adds cluster-administrator
access only after explicit approval.

An existing Kubernetes cluster is fully supported.
Akua Zero-to-Cluster is an optional path selected by the developer, never an implicit dependency or contact.

## Skills and agent instructions

Codex and Pi discover `.agents/skills/` directories from their working directory upward to the Git root.
AgentOS uses that hierarchy to expose repository development guidance to every
checkout while keeping operational roles out of contributor sessions:

- `.agents/skills/` contains workflows that apply from every AgentOS checkout
  working directory: repository development, organization evaluation and
  post-evaluation improvement review;
- `agents/.agents/skills/` contains workflows shared by First and Second Mate, including delegation, supervision, runtime, authentication, database, optional pooled AI capacity, image-build, registry and ArtifactFS Scout operations;
- `agents/firstmate/.agents/skills/` contains First-Mate-only workflows, including bootstrap, cluster handoff and Second-Mate lifecycle;
- `agents/secondmate/.agents/skills/` is reserved for workflows that are genuinely specific to a Second Mate;
- a future subtree under `clis/`, `packages/` or `services/` may add its own `.agents/skills/` when development there needs a reusable workflow.

Bootstrap explicitly loads the other skills when it reaches their boundary.
First and Second Mates can load those skills independently during normal operation, so runtime knowledge is not hidden behind bootstrap.
The public README points at root `BOOTSTRAP.md`, a stable and clickable entrypoint that forwards the agent to the canonical nested bootstrap skill.
This is a regular Markdown pointer rather than a symlink because raw GitHub content must remain useful to an agent fetching the file directly.

The root `.agents/skills/` tree is intentionally narrow. A workflow belongs
there only when it applies both to contributors and to running Agents working
on AgentOS itself. Sibling skill trees are not linked: a process started under
`agents/firstmate/` sees the root development skill, the shared Fleet skills
and its First-Mate skills, while contributor processes under `database/` or
`runtime/` see the root development skill without either role tree. First and
Second Mate run directly from their persistent AgentOS Git checkout, so Skill
updates follow Git and need no copied mirror under the home directory.

The root `AGENTS.md` is the identity-neutral repository development boundary.
It governs contributors and Mates working on AgentOS itself without selecting
an operational role. Nearer subtree instructions add their scoped boundaries;
shared Agent instructions live under `agents/`; and persistent role
instructions live in two real agent working directories:

- `agents/firstmate/AGENTS.md` is the complete First-Mate job description;
- `agents/secondmate/AGENTS.md` is the complete Second-Mate job description.

The First Mate process starts with `$HOME/projects/agentos/agents/firstmate/` as
its working directory; the Second Mate starts in the corresponding persistent
`agents/secondmate/` directory.
Codex and Pi can therefore load the selected nested instruction file without mixing both roles, while Pi still discovers the shared `.agents/skills/` directory from an ancestor up to the Git root.
Role-specific Pi configuration may live beside each persistent role under `agents/<role>/.pi/`.

Crewmates are different: their harness working directory is the isolated
project workspace, normally a Treehouse worktree and optionally a reviewed
ArtifactFS mount for an eligible Scout. The owning Mate renders a durable brief from
`agents/crewmate/BRIEF.md`; the project's own `AGENTS.md` then supplies codebase
instructions without becoming the Fleet role contract.

## Repository layout

The repository root is both the public AgentOS product surface and one Bun
workspace. The tree reflects ownership, not deployment order:

```text
.
├── README.md                         product story and onboarding entrypoint
├── VISION.md                         direction, priorities and non-goals
├── ARCHITECTURE.md                   system boundaries and repository map
├── BOOTSTRAP.md                      stable pointer to the bootstrap Skill
├── CONTRIBUTING.md                   contributor setup and verification
├── AGENTS.md                         identity-neutral repository rules
├── .agents/skills/
│   ├── agentos-development/          workflow for changing AgentOS itself
│   ├── agentos-evaluation/           benchmark execution and evidence
│   └── agentos-improvement-review/   reviewed learning from frozen evidence
├── benchmarks/
│   ├── SPEC.md                       portable metrics and reporting rules
│   ├── schemas/                      scenario and evidence JSON contracts
│   ├── scenarios/                    versioned portable evaluations
│   └── profiles/agentos/             AgentOS authority and evidence mapping
├── agents/
│   ├── AGENTS.md                     shared rules for running Agent roles
│   ├── .agents/skills/               operational Skills shared by both Mates
│   ├── .pi/background-tasks/         shared Pi extension implementation
│   ├── .pi/quota-router/             optional Fleet Codex provider extension
│   ├── firstmate/
│   │   ├── AGENTS.md                 complete First-Mate identity and duties
│   │   ├── .agents/skills/           First-Mate-only workflows
│   │   ├── .pi/extensions/           First-Mate Pi auto-load entrypoints
│   │   └── kubernetes/               workload, RBAC and client patches
│   ├── secondmate/
│   │   ├── AGENTS.md                 complete Second-Mate identity and duties
│   │   ├── .pi/extensions/           Second-Mate Pi auto-load entrypoints
│   │   └── kubernetes/               reusable Second-Mate workload base
│   └── crewmate/
│       ├── BRIEF.md                  canonical bounded-worker brief template
│       ├── images/                   optional task-specific worker images
│       └── kubernetes/               reusable separate-Pod worker base
├── clis/
│   ├── AGENTS.md                     admission boundary for shipped commands
│   └── pg-listen/                    one-notification PostgreSQL primitive
├── database/
│   ├── AGENTS.md                     SQL-first schema-development boundary
│   ├── kubernetes/cloudnative-pg/     optional self-hosted PostgreSQL topology
│   ├── migrations/                   released schema and authorization truth
│   ├── runtime/                      deterministic migration preparation
│   └── tests/                        behavioral PGlite contract tests
├── runtime/
│   ├── AGENTS.md                     shared persistent-Agent runtime boundary
│   ├── kubernetes/base/              retained-home Agent StatefulSet
│   ├── kubernetes/mate/              Pi lifecycle for First/Second Mate
│   ├── *.ts                          typed image and home lifecycle mechanics
│   └── tests/                        observable runtime behavior tests
├── services/
│   ├── AGENTS.md                     admission boundary for optional services
│   └── quota-router/                 service, tests and optional K8s topology
├── release/kubernetes/               reviewed manifest release assembly
├── docs/                             supporting assets and stable pointers
├── Dockerfile                        common AgentOS image build
├── mise.toml / mise.lock             reviewed Fleet tool baseline
├── package.json / bun.lock           workspace and dependency lock
└── THIRD_PARTY_*                     redistributed-license obligations
```

### Placement rules

- Put always-loaded identity, authority and permanent safety rules in the
  nearest `AGENTS.md` that governs their scope.
- Put conditional operational judgment in one discoverable Skill under the
  narrowest `.agents/skills/` tree shared by every intended role.
- Put a small executable in `clis/<name>/` only when a reviewed native tool
  lacks that primitive. A CLI must not hide capable tools, Agent policy or
  shadow state.
- Put reusable imported code in `packages/<name>/` only after at least one real
  consumer requires a library boundary. There is intentionally no empty
  `packages/` directory.
- Put a reviewed optional long-running network capability in
  `services/<name>/` only when native tools cannot safely provide its cross-Pod
  state and request lifecycle. Keep it authenticated, independently testable
  and outside Fleet coordination authority.
- Put retained-home, Pod-security and role-neutral Herdr mechanics shared by
  persistent Agents in `runtime/kubernetes/base/`. Add the persistent Pi Mate
  lifecycle in `runtime/kubernetes/mate/`; put role identity, credentials,
  RBAC, harness choice and role-specific probes under `agents/<role>/`.
- Put released database objects, authorization and transactional coordination
  in SQL migrations under `database/`.
- A deployable component owns its implementation, behavior tests and
  Kubernetes shape. Skills and RBAC define who may operate it. Role-specific
  workload manifests remain under `agents/<role>/kubernetes/`; release assembly
  belongs under `release/`.
- Put project orientation in `README.md`, direction and product bets in
  `VISION.md`, architectural decisions here and contributor procedure in
  `CONTRIBUTING.md`. Link across those owners instead of copying a workflow.
- Keep generated release artifacts and local review state out of source
  ownership. Their generator, immutable release or ignored workspace remains
  authoritative.

The retained-home StatefulSet shared by persistent Agents and the executable
First/Second-Mate lifecycle live under `runtime/`; this is not an agent role,
external CLI or generic importable runtime package. `runtime/kubernetes/base/`
contains only semantics common to persistent Agents, while
`runtime/kubernetes/mate/` adds Pi and Mate health behavior. Each role owns its
Kubernetes workload patch and surrounding ServiceAccount, Service, identity,
credentials, harness choice and authority under `agents/<role>/kubernetes/`.
Stateless workers do not inherit the retained-home base. Optional component
topology stays with that component even when First Mate is its normal operator.

There is no speculative CLI or placeholder application. A real missing native
primitive may enter `clis/<name>/` through the admission boundary in
`clis/AGENTS.md`; reusable imported code belongs in `packages/<name>/`. The
workspace keeps one `bun.lock`.

## Repository source-of-truth rules

- `README.md` contains product orientation and the copyable onboarding prompt.
- `VISION.md` contains project direction, current priorities, product principles and explicit non-goals.
- `ARCHITECTURE.md` contains canonical system boundaries, architectural decisions and repository placement rules.
- Root `AGENTS.md` owns identity-neutral repository boundaries and instruction-placement rules.
- `CONTRIBUTING.md` contains repository setup, development conventions and disposable-cluster smoke testing.
- `BOOTSTRAP.md` points to the canonical First-Mate bootstrap skill without duplicating its procedure.
- `docs/architecture.md` is a compatibility pointer to this document, not a second architecture source.
- `.agents/skills/agentos-development/` contains the repository-development
  workflow shared by contributors and every Agent role working on AgentOS.
- `.agents/skills/agentos-evaluation/` owns benchmark execution and sanitized
  evidence collection without changing the measured subject.
- `.agents/skills/agentos-improvement-review/` owns causal review and the
  smallest reviewed change after evidence is frozen.
- `benchmarks/SPEC.md` owns portable evaluation semantics, metrics, gates and
  reporting; its schemas, scenarios and AgentOS profile own their corresponding
  machine-readable or product-specific contracts.
- `agents/AGENTS.md` contains identity-neutral shared Agent rules.
- `agents/.agents/skills/` contains operational workflows shared by First and
  Second Mate without exposing them to contributor or runtime-development
  sessions.
- `agents/firstmate/` and `agents/secondmate/` contain the two persistent role instruction surfaces, their Pi configuration and role-scoped skills.
- `agents/crewmate/BRIEF.md` is the canonical bounded-worker contract rendered into each Assignment brief.
- `agents/crewmate/images/` owns optional task-specific worker images; it never
  expands the common Mate image or grants runtime permissions by implication.
- `clis/AGENTS.md` admits only narrow executable primitives and rejects wrappers, policy and shadow state.
- `clis/<name>/` owns each admitted command's implementation, package dependencies and behavior tests.
- `services/AGENTS.md` admits only explicitly reviewed optional network
  processes and rejects native-tool wrappers, prompt queues and shadow Fleet
  state.
- `services/quota-router/` owns the optional authenticated AI request data
  plane, its private credential/routing files, behavior tests and Kubernetes
  topology; it does not own harness choice or PostgreSQL state.
- `database/AGENTS.md` governs SQL-first schema development without selecting an Agent role.
- `database/kubernetes/cloudnative-pg/` is authoritative only for the optional
  self-hosted CloudNativePG topology; it does not own SQL schema, controller
  installation or third-party version selection.
- `runtime/AGENTS.md` governs shared container lifecycle mechanics without selecting an Agent role.
- `runtime/kubernetes/base/` owns only the retained-home StatefulSet mechanics
  shared by persistent Agents.
- `runtime/kubernetes/mate/` owns the Pi and `mate:*` lifecycle shared by First
  and Second Mate.
- `agents/firstmate/kubernetes/`, `agents/secondmate/kubernetes/` and
  `agents/crewmate/kubernetes/` are authoritative for role-owned Kubernetes
  patches and surrounding resources. A role-owned client patch wires that
  workload to a component; it does not move the component's topology into the
  role subtree.
- `services/quota-router/kubernetes/` is authoritative for the optional
  single-replica router topology; its Secret values and local overlays are not
  repository state.
- `release/kubernetes/` is authoritative for human-readable
  First-Mate and database manifest rendering; stable generated assets belong
  to immutable GitHub releases, while previews remain exact-commit builds.
- `runtime/` owns only shared persistent-Agent Kubernetes mechanics, common
  First/Second-Mate executable lifecycle and the role-neutral `agentos` image.
- `database/migrations/` and its Drizzle migration journal are authoritative for database semantics, security and applied order; `database/drizzle.tooling.ts` is deliberately empty and non-authoritative.
- Release assets pin exact versions, digests and checksums.
- `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_SOURCES.md` are authoritative for redistributed third-party licensing and source offers.

When documentation and executable assets disagree, stop and reconcile them; do not invent missing production mechanics from prose.

## Herdr distribution boundary

AgentOS remains MIT licensed.
Herdr remains a separate AGPL-3.0-or-later or commercially licensed program.
The open-source distribution path uses an unmodified, pinned Herdr executable through documented CLI and socket interfaces and ships the corresponding license, notice and source offer.
Patching, linking, embedding Herdr source, or otherwise tightening that boundary requires a fresh license review before publication.

## Deliberate exclusions

AgentOS does not introduce autonomous schedulers, heartbeat infrastructure,
AgentOS-specific Kubernetes CRDs or operators, a PostgreSQL wrapper API,
prompt queues, transcript-capturing AI gateways, task-specific PVCs, mandatory
semantic indexing, or compatibility with the failed predecessor implementation.
