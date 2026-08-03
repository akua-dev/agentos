# AgentOS resilience hard gate

Issue: [#84](https://github.com/akua-dev/agentos/issues/84)

Status: **implemented as an Effect-native executable hard gate**. A resilience
claim is ineligible unless one clean revision passes the complete parent matrix,
the ACP/A2A child gate, both approved disposable Kubernetes proofs, exact source
attestation, namespace teardown, and revision continuity.

## Non-negotiable invariants

- PostgreSQL is canonical for work, Assignments, execution epochs, and runtime
  operation state.
- Kubernetes is canonical for workload lifecycle and namespace/resource
  enforcement.
- Pi and Codex keep provider-native session custody. Herdr attaches to those
  sessions and never becomes a second session authority.
- Kubernetes TokenReview, PostgreSQL identity state, and OpenFGA jointly govern
  external-access identity. A bearer alone never grants provider scope.
- Every AgentOS-owned effectful TypeScript operation is an Effect. The migration
  policy rejects raw async/Promise orchestration, fetch, filesystem/process/
  timer access, ambient configuration, thrown domain errors, ad hoc JSON,
  assertion casts, nested runtimes, and unassigned TypeScript. A reviewed,
  domain-free, one-way host adapter may contain one runtime entry only when an
  external ABI requires it.
- Kustomize remains the deployment primitive. This gate does not introduce
  Helm, Vault/OpenBao, or blanket Internet egress blocking.

Every parent scenario requires `rollback=observed`, protected content-free
traces, bounded metric dimensions, and observability. `A` below means Herdr
attachability is also required; `D` means exact workload-plan and render
digests are required.

## Closed parent matrix

| Scenario | Expected / failure | Recovery | Minimum proof | A | D |
| --- | --- | --- | --- | --- | --- |
| `workload.pvc.fresh_start` | succeeded / none | not required | disposable Kubernetes | yes | yes |
| `workload.pvc.existing_start` | recovered / replacement | same PVC restart | disposable Kubernetes | yes | yes |
| `workload.mate.replacement` | recovered / replacement | same PVC restart | disposable Kubernetes | yes | yes |
| `workload.crewmate.replacement` | recovered / replacement | same PVC restart | disposable Kubernetes | yes | yes |
| `workload.pi.exact_resume` | recovered / replacement | native session resume | disposable Kubernetes | yes | yes |
| `workload.secret.privacy` | denied / secret privacy | not required | rendered resource | no | yes |
| `workload.secret.file_modes` | succeeded / none | not required | disposable Kubernetes | no | yes |
| `workload.resources.cpu_quota` | denied / quota | not required | disposable Kubernetes | no | yes |
| `workload.resources.memory_quota` | denied / quota | not required | disposable Kubernetes | no | yes |
| `workload.pvc.retained_node_affinity` | recovered / node affinity | same PVC restart | disposable Kubernetes | yes | yes |
| `workload.cross_namespace.denied` | denied / cross namespace | not required | disposable Kubernetes | no | yes |
| `workload.admission.denied` | denied / admission | not required | disposable Kubernetes | no | yes |
| `workload.spec.invalid` | denied / invalid spec | configuration rejected | Effect fixture | no | yes |
| `workload.spec.conflict` | denied / spec conflict | configuration rejected | PGlite | no | yes |
| `workload.render.interrupted` | recovered / render interrupted | journal repair-forward | PGlite | yes | yes |
| `workload.apply.interrupted` | recovered / apply interrupted | journal repair-forward | disposable Kubernetes | yes | yes |
| `runtime.listener.loss` | degraded / listener loss | PostgreSQL listener reconnect | Effect fixture | yes | no |
| `runtime.herdr.loss` | degraded / Herdr loss | PostgreSQL listener reconnect | Effect fixture | yes | no |
| `runtime.harness.loss` | degraded / harness loss | Herdr attach | Effect fixture | yes | no |
| `runtime.operation.prepared` | succeeded / none | not required | PGlite | yes | yes |
| `runtime.operation.applied` | succeeded / none | not required | PGlite | yes | yes |
| `runtime.operation.workload_ready` | succeeded / none | not required | PGlite | yes | yes |
| `runtime.operation.harness_ready` | succeeded / none | not required | PGlite | yes | yes |
| `runtime.operation.recovery_required` | recovered / apply interrupted | journal repair-forward | PGlite | yes | yes |
| `runtime.operation.completed` | succeeded / none | not required | PGlite | yes | yes |
| `runtime.operation.failed` | failed closed / operation failed | not required | PGlite | yes | yes |
| `runtime.operation.superseded` | recovered / operation superseded | journal repair-forward | PGlite | yes | yes |
| `gateway.config.malformed` | denied / malformed configuration | configuration rejected | Effect fixture | no | no |
| `gateway.provider.unauthorized_401` | failed closed / authentication | preserve provider error | Effect fixture | yes | no |
| `gateway.provider.rate_limited_429` | failed closed / rate limit | bounded retry | Effect fixture | yes | no |
| `gateway.provider.overload` | failed closed / overload | bounded retry | Effect fixture | yes | no |
| `gateway.provider.transport_failure` | failed closed / transport | bounded retry | Effect fixture | yes | no |
| `gateway.provider.stream_failure` | failed closed / stream | bounded retry | Effect fixture | yes | no |
| `access.identity.expired_token` | denied / token expired | projection refresh | Effect fixture | no | no |
| `access.identity.refresh_failed` | denied / refresh failed | configuration rejected | Effect fixture | no | no |
| `access.identity.stale_projection` | denied / stale projection | projection refresh | Effect fixture | no | no |
| `access.identity.scope_mismatch` | denied / scope mismatch | not required | Effect fixture | no | no |
| `access.identity.revocation` | denied / revoked | revocation observed | disposable Kubernetes | no | no |
| `supervision.retry.exhausted` | degraded / retry exhausted | not required | PGlite | yes | yes |
| `supervision.retry.resumed` | recovered / retry exhausted | supervisor resume | disposable Kubernetes | yes | yes |
| `supervision.retry.reassigned` | recovered / retry exhausted | supervisor reassignment | PGlite | yes | yes |
| `supervision.retry.stopped` | failed closed / retry exhausted | supervisor stop | PGlite | yes | yes |

The 42 ACP/A2A scenarios are composed without translation through the
[protocol child gate](./acp-a2a-resilience.md). A passing parent fixture cannot
replace a failed or incomplete child run.

## Executed evidence, not claimed evidence

`AGENTOS_RESILIENCE_EXECUTION_REFERENCES` freezes two distinct Effect regression
references for every parent scenario. The execution attestor requires each
exact repository-relative file and exact `it.effect` title to occur once with
status `passed` in the Vitest JSON report. It also requires the source-verifier,
protocol-child, parent-gate, and explicit hard-mode sentinel assertions.

The caller cannot supply scenario observations. The attestor generates them
only after the executed references pass. The workload and protocol live Effects
write separate Schema-encoded, sanitized artifacts into the runner's scoped
temporary directory. Those artifacts contribute the actual plan/render
digests, replacement/retention/quota/Secret-mode results, protocol revocation
time, and teardown result. The temporary directory is finalized by Effect and
is not a durable evidence store.

The gate rejects:

- dirty or changing Git state, an approval reference that does not end in the
  exact 40-character revision, missing/failed/duplicate assertions, or a test
  path outside the checked-out repository;
- absent hard-mode context, approval, or artifact destinations;
- missing or drifting live artifacts, unpinned required images, production
  endpoint contact, or surviving disposable namespaces;
- missing/duplicate/unobserved/failed scenarios, semantic mismatch, weak proof,
  digest loss, rollback loss, authority drift, content leakage, dynamic metric
  dimensions, unprotected traces, or lost observability/attachability.

## Disposable runbook

Create a new local Kind cluster with a pinned node image and use only its
`kind-agentos-resilience-*` context. Commit the gate first: it intentionally
refuses a dirty checkout. The five image variables must be immutable digest
references for the exact images represented by the run.

```sh
revision="$(git rev-parse HEAD)"
export AGENTOS_REPOSITORY_ROOT="$(pwd)"
export AGENTOS_KUBERNETES_TEST_CONTEXT="kind-agentos-resilience-84"
export AGENTOS_DISPOSABLE_FLEET_APPROVAL="approval:issue-84-${revision}"
export AGENTOS_RESILIENCE_AGENTOS_IMAGE_DIGEST="sha256:<64-hex>"
export AGENTOS_RESILIENCE_AGENTGATEWAY_IMAGE_DIGEST="sha256:<64-hex>"
export AGENTOS_RESILIENCE_OPENFGA_IMAGE_DIGEST="sha256:<64-hex>"
export AGENTOS_RESILIENCE_POSTGRESQL_IMAGE_DIGEST="sha256:<64-hex>"
export AGENTOS_RESILIENCE_KUBERNETES_NODE_IMAGE_DIGEST="sha256:<64-hex>"
export AGENTOS_BUN_EXECUTABLE="/absolute/path/to/bun"
export AGENTOS_KUBECTL_EXECUTABLE="/absolute/path/to/kubectl"
bun run resilience:hard-gate
```

Run the exact committed revision twice. A successful JSON result contains only
the revision, scenario counts, source counts, bounded verdict fields, and the
namespace-cleanup boolean. Inspect the context read-only, attach both sanitized
results to the PR, then delete only the disposable Kind cluster.

## Degraded behavior and rollback

Provider, listener, Herdr, harness, journal, and retry failures never create a
shadow work or session authority. The expected response is the matrix's typed
denial, failed-closed result, bounded degradation, or repair-forward action.
Retry exhaustion remains visible until a First Mate explicitly resumes,
reassigns, or stops it. Replacement preserves the intended PVC/worktree and
native session while enforcing one active writer.

Every observation records rollback. Kubernetes proof finalizers delete the
generated namespaces and admission resources even on interruption; retained
PVC behavior is proven before that teardown. No resilience verdict is eligible
when cleanup is absent.

## Privacy and observability

Proof artifacts and output contain digests and bounded booleans only. They must
never contain prompts, briefs, inbox bodies, transcripts, plans, terminal/file/
tool payloads, A2A artifacts, credentials, provider identities, or private
memory. Agent, Assignment, operation, workload, PVC, session, and protocol
identifiers belong only on protected traces, never metric dimensions. See the
[delegation and recovery observability contract](./delegation-recovery-observability.md).
