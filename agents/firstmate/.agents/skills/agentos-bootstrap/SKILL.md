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
4. Use assets from one immutable AgentOS revision. Prefer a stable release; accept an explicitly chosen preview only as an exact Git commit plus immutable OCI digest and locally rendered manifest. Stop if a required asset is absent.
5. Never create a second First Mate to resolve ambiguous state.

## Inspect

1. Determine whether the seed already runs in Kubernetes before inspecting kubeconfig:
   - check `KUBERNETES_SERVICE_HOST` with `KUBERNETES_SERVICE_PORT` or `KUBERNETES_SERVICE_PORT_HTTPS`;
   - check the standard ServiceAccount mount at `/var/run/secrets/kubernetes.io/serviceaccount/` for `token`, `ca.crt` and `namespace` without printing the token;
   - read the namespace file and treat the hostname only as a weak Pod-name hint;
   - when safe tools are available, confirm with a read-only TLS-verified Kubernetes API request using the mounted CA and credential without exposing it in logs or process arguments.
   Multiple independent signals establish high confidence. One environment variable or a hostname alone is spoofable and only a hint; an absent ServiceAccount mount does not prove a local process because automount may be disabled. Pod name and namespace environment variables exist only when explicitly supplied, commonly through the Downward API. If strong in-cluster signals are absent, enumerate contexts with `kubectl config get-contexts -o name`; never change the user's global current context.
2. Present the target topologies in this order and let the developer choose:
   - a dedicated Kubernetes cluster, whether already available or created through optional Akua Zero-to-Cluster, for the strongest and simplest isolation;
   - an [OSS vCluster with shared host nodes](https://www.vcluster.com/docs/vcluster/deploy/worker-nodes/host-nodes/isolated-workloads) inside one explicit existing host cluster, for a separate Kubernetes API, CRDs and RBAC without separate worker infrastructure;
   - a direct installation into one explicit existing cluster, accepting its selected namespace-scoped or host cluster-admin boundary.
   Keep every non-Akua path complete without Akua. Explain that shared-node vCluster is API and control-plane isolation, not independent node, kernel, CNI or CSI isolation.
3. Against the selected host or target context, inspect client and server versions, StorageClasses, namespace `agentos`, StatefulSet, Pods, PVCs, ServiceAccount and bindings. Use `kubectl auth can-i` for the exact create and update permissions the selected path needs. Keep this phase read-only. For vCluster, inspect host permissions and isolation capabilities separately from the empty virtual target.
4. If an AgentOS First Mate or home PVC already exists, inspect its ownership, release image and health. Reconcile the owned installation; never create a competing First Mate.
5. Prefer the latest stable GitHub release and require a published, immutable `v<semver>` tag plus the fixed-name AgentOS manifest assets required by the selected path. Select only assets under `/releases/download/<tag>/`, never a branch manifest or a mutable latest-download URL. If no stable release fits and the developer explicitly chooses preview software, use an exact Git commit, render from that checkout and bind every First-Mate container to the same immutable `@sha256:` image; never install a branch snapshot or mutable tag. Verify that the manifest label identifies the selected stable or preview revision. Do not expect CNPG or PostgreSQL versions in AgentOS release metadata; the database skill discovers current compatible official releases when that path is chosen.

For a dedicated or direct existing cluster, the temporary seed needs only a compatible `kubectl`, the selected context's authentication and a browser for interactive provider login. It does not need an AgentOS clone, Mise, Bun, Node, Docker, Helm or PostgreSQL. The vCluster path additionally needs a reviewed vCluster CLI only after that topology is approved. Discover the current stable version and host compatibility from the [official vCluster documentation](https://www.vcluster.com/docs/vcluster/), then install and invoke an exact version; do not install vCluster Platform implicitly. If a required client or external credential plugin is absent, explain what is missing and ask before installing it.

## Install and hand off

1. Establish the chosen target before installing AgentOS. For vCluster, create it in a dedicated host namespace with explicit host-cluster approval, enable reviewed Pod Security, resource, and network policies supported by that host, and keep a separate explicit kubeconfig or context for its API. Verify that cluster-admin inside the vCluster cannot administer the host API. Do not claim hard isolation when workloads still share host nodes or when the host CNI cannot enforce the selected NetworkPolicy.
2. Explain the namespace-scoped `agentos-firstmate.yaml` and the dedicated-target `agentos-firstmate-cluster-admin.yaml`, including the recovery operations unavailable in scoped mode. A dedicated real cluster or isolated vCluster normally uses cluster-admin inside that target; a direct shared host installation requires a separate explicit decision. Ask for the selected RBAC and installation approval.
3. Load [AgentOS Runtime](../../../../.agents/skills/agentos-runtime/SKILL.md). Apply the selected stable release URL or reviewed local preview manifest with `kubectl --context <target-context> apply -f <source>`. Never apply the AgentOS manifest through the host context when vCluster was selected.
4. Wait for the StatefulSet and verify a bound retained PVC, two successful sequential init containers, one running First Mate container, exactly one Herdr agent named `firstmate`, and the selected image digest on all three containers.
5. Load [AgentOS Authentication](../../../../.agents/skills/agentos-auth/SKILL.md). Authenticate Pi inside the persistent pod and verify a harmless real model request.
6. Replace the Pod once. Verify the same PVC identity, an Agent-home marker, exactly one First Mate pane, the same native Pi session and ordinary Mise tool resolution from a foreign worktree.
7. Attach the developer to the persistent First Mate, hand it authority and stop the local seed from performing competing Fleet work.
8. From the cluster First Mate, load [AgentOS Database](../../../../.agents/skills/agentos-database/SKILL.md). Present external PostgreSQL and self-hosted CloudNativePG without an implicit preference. After the developer chooses, use the released AgentOS database shape and apply its SQL assets as the selected Fleet-owner login; the migrations create or adopt the root First-Mate row and bind it to that same login. Do not create a separate migrator or manually map First Mate. For self-hosting, discover and verify the current compatible official CNPG and PostgreSQL releases before requesting installation approval.
9. Leave bootstrap mode only after runtime, authentication, schema, `current_agent_id()` resolving the single active root First Mate, and every security check implemented by the selected release pass.

If bootstrap or later dogfooding needs a private image path, load [AgentOS Image Builds](../../../../.agents/skills/agentos-image-builds/SKILL.md) and [AgentOS Registry](../../../../.agents/skills/agentos-registry/SKILL.md). Do not install a builder or registry merely because AgentOS itself is being installed from a public immutable image.

Repeat safely from the first incomplete verified boundary after interruption.
