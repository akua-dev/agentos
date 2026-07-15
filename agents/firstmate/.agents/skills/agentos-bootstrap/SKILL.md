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
5. Inspect the latest GitHub release and require a published, immutable `v<semver>` tag plus the fixed-name AgentOS manifest assets required by the selected path. Select only assets under `/releases/download/<tag>/`, never a branch manifest or a mutable latest-download URL for installation. Verify that every First-Mate container in the selected manifest uses the same AgentOS image pinned with `@sha256:` and that its release label matches the tag. Do not expect CNPG or PostgreSQL versions in AgentOS release metadata; the database skill discovers current compatible official releases when that path is chosen.

For an existing cluster, the temporary seed needs only a compatible `kubectl`, the selected context's authentication and a browser for interactive provider login. It does not need an AgentOS clone, Mise, Bun, Node, Docker, Helm or PostgreSQL. If `kubectl` or an external credential plugin is absent, explain what is missing and ask before installing it.

## Install and hand off

1. Explain the namespace-scoped `agentos-firstmate.yaml` and the dedicated-cluster `agentos-firstmate-cluster-admin.yaml`, including the recovery operations unavailable in scoped mode. Ask for the selected RBAC and installation approval.
2. Load [AgentOS Runtime](../../../../.agents/skills/agentos-runtime/SKILL.md). Apply the selected versioned release URL with `kubectl --context <context> apply -f <url>`.
3. Wait for the StatefulSet and verify a bound retained PVC, two successful sequential init containers, one running First Mate container, exactly one Herdr agent named `firstmate`, and the selected image digest on all three containers.
4. Load [AgentOS Authentication](../../../../.agents/skills/agentos-auth/SKILL.md). Authenticate Pi inside the persistent pod and verify a harmless real model request.
5. Replace the Pod once. Verify the same PVC identity, an Agent-home marker, exactly one First Mate pane, the same native Pi session and ordinary Mise tool resolution from a foreign worktree.
6. Attach the developer to the persistent First Mate, hand it authority and stop the local seed from performing competing Fleet work.
7. From the cluster First Mate, load [AgentOS Database](../../../../.agents/skills/agentos-database/SKILL.md). Present external PostgreSQL and self-hosted CloudNativePG without an implicit preference. After the developer chooses, use the released AgentOS database shape and apply its SQL assets as the selected Fleet-owner login; the migrations create or adopt the root First-Mate row and bind it to that same login. Do not create a separate migrator or manually map First Mate. For self-hosting, discover and verify the current compatible official CNPG and PostgreSQL releases before requesting installation approval.
8. Leave bootstrap mode only after runtime, authentication, schema, `current_agent_id()` resolving the single active root First Mate, and every security check implemented by the selected release pass.

Repeat safely from the first incomplete verified boundary after interruption.
