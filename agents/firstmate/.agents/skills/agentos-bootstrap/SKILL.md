---
name: agentos-bootstrap
description: Inspect an environment and interactively establish or reconcile a persistent AgentOS First Mate in Kubernetes. Use only for first installation, a partial bootstrap, local-clone onboarding, cluster selection, or handoff from a temporary local agent to the cluster First Mate.
---

# Bootstrap AgentOS

Treat the current local agent as a temporary seed and establish the persistent cluster First Mate before normal fleet work.

## Guardrails

1. Inspect read-only first.
2. Explain observed state and viable paths.
3. Ask before credentials, login, cost, cluster creation, Akua contact, RBAC, installation, or mutation.
4. Use assets from one immutable AgentOS release. Stop if a required asset is absent.
5. Never create a second First Mate to resolve ambiguous state.

## Bootstrap

1. Determine whether the agent already runs in Kubernetes, which explicit `kubectl` contexts are available, and whether an owned First-Mate workload and PVC exist. For an existing cluster, the temporary seed needs only a compatible Kubernetes client and its context authentication; it does not need AgentOS, Mise, Bun, Node, Docker, Helm or PostgreSQL installed locally. If the Kubernetes client or a required external credential plugin is absent, explain the selected release's supported path and ask before installing it.
2. Let the developer select an existing cluster or explicitly choose optional Akua Zero-to-Cluster.
3. Load [AgentOS Runtime](../../../../.agents/skills/agentos-runtime/SKILL.md). After approval, establish or reconcile the minimum Herdr, Pi, Mise baseline, PVC, workload, RBAC and attach runtime. The reviewed Mate image contains Mise; sequential init containers from that same image install tools on the PVC and prepare the home before First Mate starts. Install the selected release's root and `agents/` Mise configuration/lock pairs as the Agent-Pod system baseline so Fleet tools remain available in foreign Crewmate worktrees.
4. Load [AgentOS Authentication](../../../../.agents/skills/agentos-auth/SKILL.md). Authenticate the persistent Pi First Mate inside its cluster runtime and verify a harmless real model request.
5. Verify pod replacement reuses the PVC, resumes the same native Pi session and resolves released Mise tools by ordinary command name from a foreign worktree.
6. Hand authority to the cluster First Mate and stop the local seed from performing competing fleet work.
7. From the cluster First Mate, load [AgentOS Database](../../../../.agents/skills/agentos-database/SKILL.md). Select or provision PostgreSQL with approval and apply only released SQL assets.
8. Leave bootstrap mode only after runtime, authentication, database identity, schema and RLS checks pass.

Repeat safely from the first incomplete verified boundary after interruption.
