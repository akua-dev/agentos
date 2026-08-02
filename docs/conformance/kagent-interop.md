# Kagent external-provider conformance

Issue: [#129](https://github.com/akua-dev/agentos/issues/129)

Status: **completed on 2026-08-02; Kagent BYO is eligible only as an optional
external A2A provider behind AgentOS authorization. Kagent, AgentHarness and
Agent Substrate are rejected as AgentOS core runtime, custody, memory or
conversation authorities.**

## Decision

The frozen external-provider scenario passed every hard gate. Kagent v0.9.12
created a constrained BYO Deployment, exposed it through its controller A2A
route, returned the expected marker before and after Pod loss, and did not give
its controller or provider ServiceAccount access to the separate Fleet
boundary.

That result authorizes no production adoption. A future integration may
register a Kagent-managed endpoint as an external provider only when traffic
still traverses AgentOS's A2A policy-enforcement point, the active Assignment
and exact parent-child relation are checked, the provider receives an
`agentos-egress-authz` identity or an explicitly designed identity bridge, and
PostgreSQL remains the work authority. No Kagent object may become a Mate,
Crewmate, Assignment, session, memory or Fleet authority.

AgentHarness and Agent Substrate do not satisfy the current core-runtime
boundary. Their worker-pool multiplexing and actor snapshots are useful
platform mechanics, but an actor was not proven to retain an exact,
actor-scoped Kubernetes ServiceAccount identity. Kagent's v0.9.12 Substrate
path is coupled to OpenClaw/NemoClaw harnesses; Hermes uses the separate
OpenShell path. It does not provide Herdr attachment, Pi/Codex ACP custody,
AgentOS PVC/worktree retention or database-backed Assignment custody. Core
adoption therefore fails closed.

Any reconsideration requires a new Captain-approved architecture issue and a
new frozen benchmark. This result is not that approval.

## Frozen subject

The run used the exact subject declared in
[`kagent-interop-plan.md`](./kagent-interop-plan.md):

- AgentOS revision `1890c358bf40f4b2a1e264fb696ae9736dc76a17`;
- Kagent source `b45990582595acea5f6e765b86a10b251c50d5c9`, release
  and charts `0.9.12`;
- Agent Substrate source `65ca624890cb0bb141fdefa677593509e2f1d32a`,
  release and charts `0.0.6`;
- Kind `v0.32.0`, Kubernetes `v1.36.1`, Docker `29.4.0`, Helm
  `v4.1.4` and kubectl `v1.36.0`;
- scenario digest
  `sha256:19060e36c9e2bacfb18be17e5b093bf99fafce0cb9e635c648125afdb71c6716`
  and rubric digest
  `sha256:254cea5b6a3cba275f1aa363ce3ed6d914a7c25a1e09b0080b8beadeca0b46cb`.

The four OCI chart digests matched the frozen plan. The Kagent controller, UI,
PostgreSQL and BYO fixture used the declared index digests. Agent Substrate's
chart itself was immutable, but its defaults referenced several component
images by mutable tag; the live image IDs are recorded below rather than
mistaken for an immutable chart contract.

No live Fleet, model, provider, GitHub, database or AgentOS credential was used.
The only message body was the frozen public marker. Built-in Kagent agents,
tools, KMCP and optional MCP components were disabled.

## Hard-gate results

| Gate | Verdict | Direct observation |
| --- | --- | --- |
| External provider invoked | Pass | The `Agent`, generated Deployment and Service became Ready. Both bounded `message/send` calls returned one completed task containing `agentos-kagent-interop-ok`. |
| Fleet authority denied | Pass | Native impersonation reported `no` for both controller and provider ServiceAccounts reading the sentinel. The provider had no RoleBinding, Fleet volume, AgentOS/PostgreSQL credential or default API token. |
| Provider recovers | Pass | The selected Pod was deleted with its exact UID precondition. One replacement appeared under unchanged Agent and Deployment UIDs, became Ready in 17 seconds, and served exactly one second successful invocation. |
| Semantics compared | Pass | Every required comparison below is classified as observed, previously released, not applicable or unobserved; unlike workloads are not presented as equivalent latency samples. |
| Substrate boundary decided | Pass | Exact CRDs, workloads, images, storage, RBAC footprint and backend/identity limits were inspected. Missing actor-scoped workload identity fails the AgentOS adoption gate. |
| Disposable teardown complete | Pass | The fixture and all four Helm releases were removed, retained PVCs were observed, the exact Kind cluster was deleted, and the cluster, context and Docker node container were verified absent. |

The run observed zero ownership conflicts, duplicate effects, executed
authority violations and secret exposures. A rejected kubectl flag, one output
formatting mistake and one incorrect read-only chart lookup are disclosed as
failed evaluator tool calls; none mutated the subject or changed the frozen
scenario.

## BYO observation

The local cluster was created at `2026-08-02T13:10:35Z`. Kagent's three core
Pods were created at `13:11:38Z`; the UI became Ready in 17 seconds,
PostgreSQL in 29 seconds and the controller in 61 seconds. The controller
restarted three times while its bundled PostgreSQL endpoint refused startup
connections, then recovered without intervention.

The BYO `Agent` was accepted at `13:13:06Z` and Ready at `13:13:26Z`, a
20-second cold resource-to-readiness observation including the initial image
pull. It retained these resource identities across the declared fault:

- Agent UID `2cdd2339-4936-4634-b88f-722e01656f71`;
- Deployment UID `733edbc1-6324-4b16-a42a-29aa34145b03`;
- original Pod UID `ef43a272-3b37-47d0-b76f-5d76bb474aec`;
- replacement Pod UID `2bd85445-6763-498a-934b-8a482588308d`.

The first controller-routed invocation succeeded. The exact old Pod was then
stopped at `13:15:19Z`; Kubernetes created one replacement at the same second,
and it became Ready at `13:15:36Z`. One and only one post-recovery invocation
returned HTTP 200 and the marker in 9.620 milliseconds. This is a warm latency
for a static in-cluster fixture, not evidence of model or coding-task latency.

Kagent synthesized the public Agent Card rather than preserving the fixture
card exactly: the routed card advertised protocol `0.3` and `1.0` interfaces
and `streaming: true`, while the fixture deliberately declared streaming
unsupported. An AgentOS integration must therefore validate the controller
card and response envelope at its own boundary; it cannot infer provider
capabilities from the backing Pod's card.

The requested ServiceAccount and pod/container security, resource, volume and
scheduling fields survived translation. The provider had a read-only root,
dropped every capability, ran as UID/GID 101, requested 10m CPU/16Mi memory,
and had no PVC. Kagent nevertheless injected a projected one-hour token with
audience `kagent` at `/var/run/secrets/tokens`, despite default ServiceAccount
token automount being disabled. The token was not read. It cannot authenticate
to AgentOS's `agentos-egress-authz` audience and is not an acceptable identity
bridge.

At the idle sample, the three Kagent control-plane Pods used approximately
3.739m CPU and 162.5MiB working set, while requesting 450m CPU and 640MiB
memory. The BYO Pod used approximately 0.062m CPU and 10.1MiB working set,
while requesting 10m CPU and 16MiB memory. Kagent also held a 500Mi evaluation
PostgreSQL PVC.

## Native and external-path comparison

The native column uses released AgentOS evidence where it exists. It does not
pretend that a deterministic Nginx A2A fixture is comparable with a coding
agent or with the published Quickstart workload.

| Dimension | Native AgentOS | Kagent BYO external provider | AgentHarness / Substrate |
| --- | --- | --- | --- |
| Task success | The released v0.1.0 baseline passed three of five declared Quickstart attempts; all attempts remain published. No native workload ran in this isolated attempt. | Observed two of two bounded marker invocations, one on each Pod UID. This proves transport interoperability only. | No AgentOS task ran; not applicable to the BYO gate. |
| Persistence | PostgreSQL owns Task/Assignment/Inbox state; a per-Mate StatefulSet retains a 20Gi PVC, worktree and native session. | The Agent CR and controller database survive Pod replacement, but the tested provider has only ephemeral volumes and retained no session or work. | Per-harness ActorTemplate plus golden/incremental snapshots to object storage; worker capacity is separate and shared. This is not AgentOS PVC, worktree or native-session custody. |
| Attachability | Herdr attaches to the exact Mate runtime; ACP retains a single Pi/Codex writer and provider-native session authority. | Standard Kubernetes logs/exec are possible, but no Herdr or native harness-session attachment was observed. | AgentHarness advertises exec/SSH and UI gateway attachment for its supported backends; no Herdr or Pi/Codex ACP attachment contract exists. |
| Identity | One Mate Pod has one ServiceAccount and short-lived `agentos-egress-authz` projection, correlated to Agent and active Assignment. | A dedicated Pod ServiceAccount is configurable, but Kagent injects its own `kagent`-audience token. Both provider and controller were denied Fleet access. | The controller authenticates to ate-api; actors multiplex over a WorkerPool. Exact actor-to-AgentOS ServiceAccount identity was not proven and therefore fails closed. |
| Privacy | Database projections, gateway policy and bounded telemetry keep native sessions and private memory out of protocol traces. | Only public fixture content was used. Real payload confidentiality and Kagent controller/database retention were unobserved; all routed A2A content crosses the Kagent controller. | Snapshot/object-store, workflow and router components enlarge the content-bearing trust boundary. Kagent-generated harness config and referenced secrets are resolved through control-plane components. |
| Recovery | The released held-out run detected loss in 30.96s and resumed useful native work 110.416s later with the same Agent, Task, Assignment, PVC, worktree and session. | Pod replacement became Ready in 17s with stable Agent/Deployment identity, no durable work, and zero duplicate marker calls. | Snapshot/resume is an architectural feature, but actor and dependency fault recovery was not executed here; unobserved. |
| Cold latency | No comparable cold native A2A-provider measurement exists. Published Quickstart seed-to-delivery is a different workload and is not reused. | 20s from Agent creation to Ready, including first image pull. | Default Substrate control plane took 66s from creation to its last running Pod becoming Ready; no actor was created. |
| Warm latency | Unobserved for a comparable deterministic provider. | 9.620ms for the single allowed post-recovery controller-routed static response. | Actor wake/resume latency unobserved. |
| Idle resources | Per-Crewmate manifest requests 250m CPU/512Mi memory and a 20Gi PVC; shared database/gateway services are additional. Same-cluster actual usage was unobserved. | Core: 3 Pods, 450m CPU/640Mi requested, about 3.739m CPU/162.5Mi actual, plus 500Mi PVC. Fixture: 10m CPU/16Mi requested, about 0.062m CPU/10.1Mi actual. | 12 running Pods used about 15.566m CPU/364.5Mi working set. The chart declares no container requests, so scheduling guarantees are absent. |
| Storage | One 20Gi Mate PVC plus durable PostgreSQL storage by default. | The fixture had no PVC; bundled evaluation PostgreSQL used 500Mi. | Six 1Gi Valkey PVCs plus one 1Gi RustFS PVC. Six Valkey claims remained after Helm uninstall until cluster deletion. |
| Operating complexity | AgentOS-specific StatefulSets, PostgreSQL, Herdr, ACP, A2A PEP and normal observability; each component preserves one declared authority. | Adds controller, CRDs, UI and PostgreSQL even with built-ins disabled; an external-only integration must also operate its identity bridge and A2A policy boundary. | Adds two CRDs, five ClusterRoles/bindings, five Deployments, one DaemonSet, one StatefulSet, two Jobs, routing/DNS, six-node Valkey, RustFS/object storage, workflow API/controller and gVisor worker machinery. |

## Agent Substrate footprint and rejection

The two pinned `0.0.6` charts installed successfully in `ate-system`. Twelve
long-running Pods became Ready without restart: ate-api-server,
ate-controller, node-level atelet, atenet plus Agentgateway, dedicated DNS,
RustFS and six Valkey replicas. Two initialization Jobs completed. The chart
rendered five ClusterRoles, five ClusterRoleBindings, two namespaced Roles and
bindings, five ServiceAccounts, seven Services, five Deployments, one
DaemonSet, one StatefulSet, three Secrets and four ConfigMaps.

Observed component image identities were:

- `ateapi@sha256:9e488cd2fa884dbe957b9d69ff0424ab5e4bfbe03d124e444b402c7b892ac9aa`;
- `atecontroller@sha256:8c2d868f934829eea0806dedf174333b0f171bdff2f13dc06333a0ce9403c87c`;
- `atelet@sha256:b27e10658ab0a0463bd1a48e1bda8750fc789ad987f7a58c868897df23fd0102`;
- `atenet@sha256:b34bb15533b6380ac230e74307e6719826941f6e352418d76292eaf2faa953a6`;
- `agentgateway@sha256:95e8d849c44ba31399daf504367ecfcfe2d3d3e59ffd96b1098234353afc3ef7`;
- `coredns@sha256:1eeb4c7316bacb1d4c8ead65571cd92dd21e27359f0d4917f1a5822a73b75db1`;
- `valkey@sha256:70956f1339ef77d8dae58459c1ff282a74a88ca68d281f4d816dfc74a6ba916b`;
- the already digest-pinned RustFS and AWS CLI images declared in the plan.

The rendered defaults also include tag-only `busybox:1.36`; the ate*,
Agentgateway, CoreDNS and Valkey chart references are tag-only even though the
local runtime resolved them to the digests above. A later registry update could
therefore change the installed subject without a values change.

AgentHarness is a backend-specific remote environment, not a general AgentOS
workload declaration. The v0.9.12 CRD admits OpenClaw, NemoClaw and Hermes with
OpenShell or Substrate runtime, but the Substrate implementation builds only
OpenClaw/NemoClaw backends. It generates one ActorTemplate per harness and
uses a separately managed shared WorkerPool. Snapshot persistence defaults to
object storage; ate-api workflow state depends on Valkey; network access
depends on atenet/DNS/Agentgateway; and gVisor/pause/runsc artifacts form
another runtime supply chain.

These are the decisive failure modes:

- controller or PostgreSQL loss blocks Kagent reconciliation, routing and UI;
- CRD/controller skew can strand Agent, AgentHarness, ActorTemplate or
  WorkerPool resources;
- controller-generated Agent Cards may overstate backing-provider
  capabilities;
- Kagent memory and conversation state are separate, non-authoritative stores
  that can diverge from AgentOS PostgreSQL;
- ate-api/controller loss blocks actor workflow and resume;
- Valkey loss blocks workflow state, while RustFS/object-store loss blocks
  snapshot persistence and restore;
- atenet, DNS or Agentgateway loss isolates otherwise-running actors;
- WorkerPool or atelet loss affects multiple multiplexed actors and makes one
  Pod ServiceAccount an invalid proxy for exact actor identity;
- gVisor/runsc, pause, harness and tag-only component artifacts add independent
  compatibility and supply-chain failure surfaces;
- snapshot success does not prove retained AgentOS worktree, native ACP session,
  Assignment custody or Herdr attachability;
- Helm uninstall left six StatefulSet PVCs behind, requiring an explicit
  storage-retention decision and cleanup.

The potential density and snapshot-start benefits do not compensate for those
authority mismatches. AgentOS should keep its typed StatefulSet/PVC Mate
contract and protocol boundaries. Kagent can remain an external system that
speaks A2A; it must not become the system that declares or owns Mates.

## Teardown evidence

The fixture namespaces, ServiceAccount, ConfigMaps and Agent were deleted
first. Helm then successfully uninstalled `substrate`, `substrate-crds`,
`kagent` and `kagent-crds`; `helm list --all-namespaces` returned no releases.
The Kagent/ATE CRDs were absent. Six 1Gi Valkey PVCs remained, which was
recorded rather than hidden.

The exact `agentos-kagent-129` cluster was then deleted. Final checks reported
no Kind clusters, no `kind-agentos-kagent-129` kube context and no
`agentos-kagent-129-control-plane` Docker container. The retained disposable
PVCs were removed with that nonrecoverable cluster deletion. A production
dependency diff contains only the frozen benchmark fixture, scenario and these
conformance documents; no Kagent chart, image, controller, CRD, UI, memory,
conversation loop, database or Substrate component entered AgentOS manifests,
release assets, bootstrap or dependencies.

## Primary references

- [Kagent API reference](https://kagent.dev/docs/kagent/resources/api-ref)
- [Kagent BYO A2A example](https://kagent.dev/docs/kagent/examples/a2a-byo)
- [Kagent AgentHarness](https://kagent.dev/docs/kagent/concepts/agent-harness)
- [Kagent Agent Substrate](https://kagent.dev/docs/kagent/concepts/agent-substrate)
- [Kagent installation](https://kagent.dev/docs/kagent/introduction/installation)
