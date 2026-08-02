# AgentOS AI observability runbooks

Keep every investigation privacy-safe. Use the controlled matrix when comparing
extensions, and keep serving readiness independent of Collector/backend health.

<a id="authentication-failures"></a>
## Authentication failures

Confirm the failing layer and bounded `authentication` class. Compare direct
and Gateway routes only when credentials/model are equivalent. For Gateway
routes, inspect whether failure occurs during account refresh, route acquire, or
upstream response. Do not print tokens or provider account identity. Repair or
reauthorize only the selected credential authority, then run a fresh and
resumed smoke.

<a id="quota-and-rate-limit"></a>
## 429 and quota/rate limit

Check quota observation age/stale state, response status, retry-after handling,
eligible route count, and calls per operation. Distinguish provider 429 from a
Gateway no-account 503. Use quota-aware account selection; do not rotate
accounts blindly or treat known usage as an extension failure.

<a id="gateway-capacity-and-provider-overload"></a>
## Gateway capacity and provider overload

Follow `ai-gateway.route.acquire` before `ai-gateway.upstream`. No upstream span
means routing/capacity; an upstream 502/503/529 means provider or transport
overload. Verify every lease has one release on success, fetch failure, stream
failure, abort, and disconnect. Compare a supported direct route using the
paired matrix before attributing the fault to the Gateway.

<a id="stream-and-decompression-failures"></a>
## Stream and decompression failures

Compare upstream-header, first-byte, stream duration, chunks, bytes, content
encoding class, and bounded stream outcome. A failure before first byte differs
from decode after forwarded chunks or downstream cancellation. Confirm the
Gateway requests identity encoding and strips stale response
`content-encoding`. Never log stream content or raw decoder messages.

<a id="extension-and-session-amplification"></a>
## Extension and session amplification

Run the fresh/resumed default-versus-`-ne -e observability` matrix with the same
pod, model, route, and fixture. Compare provider attempts per operation and
request-kind mix. Add Mate memory, compaction, background tasks, and supervision
one at a time. Disable only the proven extension, retain a rollback value, and
verify the rendered pod template and live session.

<a id="collector-or-backend-outage"></a>
## Collector or backend outage

First confirm inference still serves. Inspect workload exporter failures,
Collector receiver acceptance, exporter failures, retry/backoff, persistent
queue occupancy, and remote backend availability. Restore the remote endpoint
or Secret without restarting AI workloads. Verify queue drain and document any
bounded eviction/data gap.

<a id="collector-pvc-pressure"></a>
## Collector PVC pressure

Measure queue and diagnostic archive usage separately. Disable or remove only
the optional diagnostic overlay before considering queue data. Increase the
retained PVC through the storage authority when required. Never delete the PVC
or queue during an active incident without explicit destructive-action
authority and a documented data-loss boundary.

<a id="missing-telemetry"></a>
## Missing telemetry

Check workload activity, `OTEL_SDK_DISABLED`, `OTEL_*` endpoint/protocol/signal
selectors, Pi observability extension activation, Codex `[otel]` exporters,
Collector NetworkPolicy and receiver counters, pipeline processors/exporters,
queue health, and backend ingest. A healthy request with absent spans is a
telemetry fault, not evidence that the AI path is healthy or unhealthy.

<a id="invalid-or-conflicting-workload-plan"></a>
## Invalid or conflicting workload plan

Start at the protected `agentos.resilience.operation` trace. Compare the
workload plan's spec and overlay digests with the runtime journal's reviewed
render digest; never retrieve or attach raw YAML. A cause of
`invalid_workload_plan` belongs to schema/profile compilation. A cause of
`conflicting_workload_plan` belongs to stale authority, incompatible desired
state, or a competing operation. Confirm the topology proposal is still valid,
that its Agent and Assignment correlation matches, and that only one durable
operation owns reconciliation. Supersede stale work or repair forward from the
durable journal; do not mutate a live Pod by hand.

<a id="stuck-or-retry-exhausted-operation"></a>
## Stuck or retry-exhausted operation

Walk the ordered child spans and stop at the last observed phase: workload plan,
render, apply, capacity, placement, semantic readiness, provider, listener,
protocol, native session, reconciliation, or outcome. `render_boundary` and
`apply_boundary` identify manifest boundaries; `capacity` and `placement`
identify cluster scheduling; `readiness`, `provider`, and `listener` identify
semantic startup; `retry_exhausted` is terminal evidence after the bounded
retry policy. Check the runtime journal attempt and recovery class, but look up
the operation, Pod, PVC, or session only in the protected trace. Do not increase
retry bounds until the underlying cause and duplicate-side-effect risk are
known.

<a id="repaired-operation-loop"></a>
## Repaired operation loop

For repeated `repair_forward`, correlate `reconciliation` with the exact
reviewed render digest and the next readiness/outcome span. Distinguish
`reconciliation` drift from `policy` denial and `native_session` loss. Confirm
the journal advances monotonically, a superseded operation never writes again,
and each retry resumes from durable evidence instead of replaying an already
completed side effect. If the loop cannot make a new durable transition, stop
or reassign it through the owning controller rather than deleting retained
state.

<a id="protocol-fallback-degradation"></a>
## Protocol fallback degradation

For ACP/A2A evidence, separate `protocol_adapter` transport loss from `policy`
denial, `listener`/PostgreSQL unavailability, and `native_session` replacement.
Verify the canonical work record before and after fallback. The supported
recovery path is PostgreSQL listener delivery followed by Herdr wake where
declared; it must preserve one writer and one durable mutation. Inspect the
protected protocol and Assignment IDs only after bounded protocol metrics show
impact. Repeated successful fallback is still degraded transport and should be
repaired rather than normalized.

<a id="unobserved-resilience-boundary"></a>
## Unobserved resilience boundary

An expected source that cannot emit evidence must produce an explicit
`unobserved` outcome/recovery pair. Check the workload plan, runtime journal,
semantic readiness, native session, and ACP/A2A projection in that order, then
check Collector receive/export health. Never substitute a missing series with a
success assumption. Collector failure cannot influence controller decisions,
reconciliation, readiness, retry, or fallback; restore telemetry independently
and record the evidence gap.

## Bounded cause-to-evidence map

| Cause | Native evidence source | First response |
| --- | --- | --- |
| `invalid_workload_plan` | workload plan | Revalidate the Effect Schema and selected profile. |
| `conflicting_workload_plan` | topology/workload plan plus runtime journal | Resolve durable ownership and supersede stale work. |
| `render_boundary` | reviewed render digest | Reproduce the render from the same spec/overlay digests. |
| `apply_boundary` | runtime journal and Kubernetes apply result | Inspect bounded apply status without recording YAML. |
| `capacity` | Kubernetes scheduling/capacity evidence | Confirm requests, quotas, and available capacity. |
| `placement` | Kubernetes Pod/PVC placement evidence | Confirm node, volume, and affinity constraints. |
| `readiness` | semantic readiness | Follow the stable readiness component class. |
| `provider` | provider readiness and AI route evidence | Repair the selected provider authority. |
| `listener` | PostgreSQL listener and coordination readiness | Restore catch-up/listening before Herdr wake. |
| `protocol_adapter` | ACP/A2A adapter conformance evidence | Verify fallback and single-writer custody. |
| `native_session` | native session availability/resume evidence | Resume the native session without transcript capture. |
| `policy` | bounded authorization decision | Repair the binding/profile/ceiling, never bypass it. |
| `reconciliation` | runtime journal transition | Repair forward from the last durable phase. |
| `retry_exhausted` | terminal runtime journal outcome | Stop or reassign after cause-specific review. |

`none` is reserved for a successful/pending observation or explicit unobserved
evidence; it is not a substitute for an unknown failure.
