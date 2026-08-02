# Kagent external-provider conformance plan

Issue: [#129](https://github.com/akua-dev/agentos/issues/129)

Status: **completed frozen plan**. The observations and adoption decision are
recorded in [`kagent-interop.md`](./kagent-interop.md); this document remains the
unaltered pre-run contract.

## Boundary

This is one `conformance` attempt against a newly created local Kind cluster.
It may install the exact third-party charts below, create only the frozen
benchmark fixture, delete only the selected BYO provider Pod after the first
successful invocation, inspect native authorities, and delete the exact
cluster. It must not contact a live Fleet or reuse any AgentOS, model, provider,
database, GitHub or other credential.

Kagent remains an optional external A2A provider under evaluation. No Kagent
controller, CRD, UI, memory, conversation loop, database, chart, image or
Substrate component may enter AgentOS first-party manifests, releases,
bootstrap or production dependencies through this run.

## Frozen subject and environment

- AgentOS A2A contract revision:
  `1890c358bf40f4b2a1e264fb696ae9736dc76a17`.
- Kagent release: `v0.9.12`, source
  `b45990582595acea5f6e765b86a10b251c50d5c9`.
- Kagent chart: `0.9.12`,
  `sha256:ec0dacc1a76edbd190a554757c8bdb193ccb0b35deeb35f6d7a7e7ffc76d99fd`.
- Kagent CRD chart: `0.9.12`,
  `sha256:85174e69eab19e05fcf82dbfda86e8e84c2be97a52c645d60cf1ae51ccbca977`.
- Kagent controller image index:
  `cr.kagent.dev/kagent-dev/kagent/controller:0.9.12@sha256:d1ea7b70bb8d97de9f0774d44b598971c944b3ab4e88294b0bb78e59d1a63c15`.
- Kagent UI image index:
  `cr.kagent.dev/kagent-dev/kagent/ui:0.9.12@sha256:1d5ada8d7f65a6b9ad28232463f9fd670c4c20875baa1c8008aaa1f1f988382e`.
- Bundled evaluation PostgreSQL image index:
  `docker.io/library/postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`.
- Agent Substrate release: `v0.0.6`, source
  `65ca624890cb0bb141fdefa677593509e2f1d32a`.
- Substrate chart: `0.0.6`,
  `sha256:6a77620b8b946270d6720db7006fb78b48eb24dd1235ab9a208ef2834f5b5796`.
- Substrate CRD chart: `0.0.6`,
  `sha256:08288f647f08398e36830fc16f2c38a46793c5a23db1c2ddd209f2b5b8072949`.
- BYO fixture image index:
  `nginxinc/nginx-unprivileged:1.29.1-alpine@sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e`.
- Kind `v0.32.0`; Kubernetes node
  `kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5`.
- Docker `29.4.0`, Helm `v4.1.4`, kubectl `v1.36.0`.
- Cluster name `agentos-kagent-129`; context `kind-agentos-kagent-129`.
- Approval reference `approval:captain-2026-08-01-kagent-129`.

The stable Kagent release was selected instead of the v0.10.0 release
candidate. The Kagent chart is restricted to `kagent-system` and
`kagent-interop`; all built-in agents, tools, kmcp and optional MCP components
are disabled. Its controller, UI and evaluation-only PostgreSQL images are
pinned by index digest. The fixture uses no model and no provider credential.

Kagent v0.9.12 unconditionally projects a one-hour `audience: kagent`
ServiceAccount token into every Agent Pod. The fixture disables default token
automount and has no RoleBinding, but it deliberately does not pretend this
controller-owned projection is absent. The run must prove that the projected
identity cannot read the Fleet-boundary sentinel and record that its audience
does not satisfy AgentOS's `agentos-egress-authz` workload-token contract.

The Substrate assessment may install only the two pinned 0.0.6 charts in
`ate-system`. Every rendered and observed component image, workload, PVC, CRD,
Role and binding must be recorded. A component that the third-party chart
leaves tag-pinned rather than digest-pinned is an explicit adoption risk, not
permission to present it as immutable.

## Frozen scenario

- Scenario:
  `benchmarks/scenarios/external-a2a-provider-interop/scenario.json` version
  `0.1.0`.
- Canonical scenario digest:
  `sha256:19060e36c9e2bacfb18be17e5b093bf99fafce0cb9e635c648125afdb71c6716`.
- Canonical rubric digest:
  `sha256:254cea5b6a3cba275f1aa363ce3ed6d914a7c25a1e09b0080b8beadeca0b46cb`.
- Fixture:
  `benchmarks/fixtures/kagent-byo/`.
- Approval covers the one declared `delete-external-provider-pod` fault only
  after the first bounded invocation succeeds.
- The successful marker is `agentos-kagent-interop-ok`; prompts, model output,
  credentials and private content are absent by construction.
- Completion requires the second verified marker after a new Pod UID, exact
  authority denials, the BYO/Substrate comparison, and cluster deletion.

The scenario and rubric digest are recorded in the frozen attempt before the
cluster is created. Any post-freeze change becomes a deviation and a new
attempt; it is never repaired silently inside this attempt.
