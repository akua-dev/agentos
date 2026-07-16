# Agent-owned runtime and Kubernetes assets

## Goal

AgentOS keeps executable agent behavior beside the role that uses it. Humans
and local seed agents use the external `agentos` CLI; running First and Second
Mates use native Kubernetes, PostgreSQL, Herdr, Treehouse and harness commands
described by their `AGENTS.md` files and skills. AgentOS does not add thin spawn
or render wrappers around those tools.

## Repository boundary

The root `deploy/` directory is removed. Runtime and Kubernetes ownership moves
under `agents/`:

```text
agents/
├── mate/
│   └── runtime/              # shared Home, Herdr, Pi and health mechanics
├── firstmate/
│   ├── AGENTS.md
│   ├── Dockerfile
│   ├── mise.toml
│   └── kubernetes/
│       ├── base/             # persistent First Mate
│       ├── cluster-admin/    # explicit dedicated-cluster authority
│       └── database/         # optional CloudNativePG topology
├── secondmate/
│   ├── AGENTS.md
│   ├── mise.toml
│   └── kubernetes/           # persistent Second Mate workload base
└── crewmate/
    ├── AGENTS.md
    └── kubernetes/           # task-scoped Crewmate workload base
```

Each agent type owns one workload base. There are no copied Crewmate manifests.
From `/opt/agentos/agents/firstmate`, First Mate reaches its own bootstrap assets
as `kubernetes/...` and child assets as `../secondmate/kubernetes` and
`../crewmate/kubernetes`. Second Mate reaches only `../crewmate/kubernetes`.
Crewmates never create agents.

The common `agents/mate/` subtree receives an `AGENTS.md` that limits it to real
shared container-runtime behavior. Role-local Kubernetes subtrees inherit their
role instructions. `packages/cli/AGENTS.md` states that the CLI serves humans
and agents outside the cluster and must not accumulate in-cluster orchestration
or wrappers around native tools.

## Workload creation

The immutable release provides Kustomize bases, not a custom spawn program. A
supervising Mate:

1. resolves Captain authority and the existing Fleet identity, Task,
   Assignment, database principal and credential Secret;
2. chooses the workload image and optional harness settings using Captain policy
   and task judgment;
3. writes a small per-agent Kustomize overlay under
   `$HOME/.local/state/agentos/workloads/<handle>/`;
4. renders and inspects it with native `kubectl kustomize`;
5. uses native `kubectl diff` and `kubectl apply` after any required approval;
6. verifies the resulting ServiceAccount, StatefulSet, Pod, PVC, image
   identity, Herdr session and database identity directly.

The skills provide the exact verified command shapes, required fields, safety
checks and recovery sequence. Kubernetes remains workload truth; the overlay is
an agent-owned operational input, not a second state database.

The current `deploy/kubernetes/mate/render-secondmate.ts` and
`deploy/kubernetes/crewmate/spawn.ts` implementations, their Mise tasks and
wrapper-specific tests are removed. Kustomize render tests and genuine runtime
tests remain beside the owning agent assets.

## Harness and Pi policy

First and Second Mates use Pi, but AgentOS does not prescribe a release-wide
model or thinking level. Pi owns its persistent settings and authentication on
the agent PVC. Home reconciliation preserves those files and does not seed or
reconcile `defaultProvider`, `defaultModel` or `defaultThinkingLevel`.

The Pi defaults extension, `AGENTOS_MODEL`, `AGENTOS_THINKING` and their hardcoded
`gpt-5.6-terra`/`high` defaults are removed. Authentication guidance covers the
native Pi browser-login flow without selecting a model on the user's behalf.

A shared harness skill adopts the useful predecessor pattern:

1. an explicit Captain choice wins;
2. durable natural-language dispatch policy is considered by the supervising
   Mate using its own judgment;
3. absent model or effort values mean the selected harness uses its native
   default;
4. only empirically verified harness flags are documented and used;
5. provider and harness CLIs report their own errors directly to the Mate.

No TypeScript union attempts to make all harnesses share one set of thinking or
effort values.

## Documentation and verification

The README remains the canonical product architecture and is updated when this
design lands. Role behavior and native operational commands live in scoped
`AGENTS.md` files and skills rather than being duplicated in the README.

Verification is limited to behavior that matters: every Kustomize base renders,
the First-Mate image references the moved runtime paths, home preparation
preserves Pi-owned state, and the repository has no stale `/deploy`, spawn
wrapper, Pi-default reconciler or hardcoded model/thinking references.
