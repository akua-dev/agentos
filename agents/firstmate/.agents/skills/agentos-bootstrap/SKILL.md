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

## Inspect

1. Determine whether the seed already runs in Kubernetes. Enumerate contexts with `kubectl config get-contexts -o name`; never change the user's global current context.
2. Let the developer choose one explicit existing context or explicitly choose optional Akua Zero-to-Cluster. The existing-cluster path must remain complete without Akua.
3. Against the selected context, inspect client and server versions, StorageClasses, namespace `agentos`, StatefulSet, Pods, PVCs, ServiceAccount and bindings. Use `kubectl auth can-i` for the exact create and update permissions the selected path needs. Keep this phase read-only.
4. If an AgentOS First Mate or home PVC already exists, inspect its ownership, release image and health. Reconcile the owned installation; never create a competing First Mate.
5. Fetch `https://github.com/akua-dev/agentos/releases/latest/download/release.json`. Require a semantic version, an image pinned with `@sha256:`, and every manifest and database dependency field required by the selected path. Inspect GitHub release `v<version>` and require it to be published and immutable. Select only assets under `/releases/download/v<version>/`, never a branch manifest.

For an existing cluster, the temporary seed needs only a compatible `kubectl`, the selected context's authentication and a browser for interactive provider login. It does not need an AgentOS clone, Mise, Bun, Node, Docker, Helm or PostgreSQL. If `kubectl` or an external credential plugin is absent, explain what is missing and ask before installing it.

## Install and hand off

1. Explain the namespace-scoped `agentos-firstmate.yaml` and the dedicated-cluster `agentos-firstmate-cluster-admin.yaml`, including the recovery operations unavailable in scoped mode. Ask for the selected RBAC and installation approval.
2. Load [AgentOS Runtime](../../../../.agents/skills/agentos-runtime/SKILL.md). Apply the selected versioned release URL with `kubectl --context <context> apply -f <url>`.
3. Wait for the StatefulSet and verify a bound retained PVC, two successful sequential init containers, one running First Mate container, exactly one Herdr agent named `firstmate`, and the selected image digest on all three containers.
4. Load [AgentOS Authentication](../../../../.agents/skills/agentos-auth/SKILL.md). Authenticate Pi inside the persistent pod and verify a harmless real model request.
5. Replace the Pod once. Verify the same PVC identity, an Agent-home marker, exactly one First Mate pane, the same native Pi session and ordinary Mise tool resolution from a foreign worktree.
6. Attach the developer to the persistent First Mate, hand it authority and stop the local seed from performing competing Fleet work.
7. From the cluster First Mate, load [AgentOS Database](../../../../.agents/skills/agentos-database/SKILL.md). Select an external endpoint or provision the released CloudNativePG path with approval, then apply only released SQL assets.
8. Leave bootstrap mode only after runtime, authentication, database identity, schema and every security check implemented by the selected release pass.

Repeat safely from the first incomplete verified boundary after interruption.
