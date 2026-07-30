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
