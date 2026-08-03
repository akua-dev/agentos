# AI Gateway Effect telemetry implementation plan

**Issue:** #59
**Base:** `5c179c78f0fb6bb9fdf4c536b3598814e482caef`

## Outcome

Finish AI Gateway request telemetry without retaining its legacy imperative
OpenTelemetry core. Every operation, state transition, timer, ID, log, span,
metric, exporter lifecycle, and failure boundary remains inside Effect. A
Collector outage or telemetry defect must never change provider semantics,
hold a streaming response, leak protected data, or affect readiness.

## Design

- Replace `telemetry.ts` plus `makeLegacyAIGatewayTelemetry` with one native
  `AIGatewayTelemetry` Effect service and live/no-op layers.
- Build request/authentication/route/upstream/stream/release spans with Effect
  tracing. Use `SynchronizedRef` for atomic request state and aggregate
  chunks/bytes; never create one span or metric update per stream chunk.
- Use Effect `Metric` instruments with the checked-in telemetry contract and
  explicit histogram boundaries. Add bounded route-event, quota-refresh, and
  completed-stream metrics where the current contract cannot prove the issue
  outcomes.
- Emit correlated failure logs with Effect logging and only allowlisted fields.
  Preserve incoming W3C parentage and inject the current attempt trace context
  plus a unique `X-Client-Request-Id`, without copying arbitrary headers.
- Install `effect/unstable/observability` OTLP logs, metrics, and tracing from
  standard `OTEL_*` configuration using protobuf, bounded asynchronous batches,
  Effect HTTP, scoped flushing, and fail-open defaults. Do not run a second
  imperative SDK or make readiness depend on exporter health.
- Keep the current no-retry provider rule: there is one upstream attempt per
  request today. Instrument each attempt distinctly without adding failover.

## TDD sequence

1. Replace the legacy-boundary tests with failing tests that capture native
   Effect spans, metric snapshots, and logs for success, authentication,
   acquisition, release, and streaming correlation.
2. Add failing privacy and cardinality tests using representative prompts,
   tool data, credentials, provider identities, response bodies, and raw
   upstream errors.
3. Add failing lifecycle tables for 429, 503, other 5xx, timeout, reset,
   malformed protocol/SSE, encoded responses, bodyless responses, and client
   cancellation. Assert one release for every acquired lease and zero active
   streams/reservations afterward.
4. Implement the native service, contract additions, and OTLP runtime layer
   until those tests pass; delete the legacy implementation and adapter.
5. Add an Effect-native repeatable overhead harness, choose a conservative
   request-lifecycle budget, record the measurement method, and keep export
   traffic out of the hot streaming path.
6. Run focused tests, the Effect migration gate, the full repository check,
   and any live Collector integration needed to prove OTLP payloads. Open a PR,
   wait for exact-head checks, merge, and require green default-branch CI before
   recording #59 complete.

## Primary references

- Effect 4 `effect/unstable/observability/Otlp` source and local API docs for
  scoped OTLP HTTP batching, flushing, standard environment configuration, and
  Effect tracer/metric/logger installation.
- Effect 4 `Tracer`, `Metric`, `Clock`, `Crypto`, `Ref`, `Logger`, and
  `HttpClient` APIs from the pinned workspace dependency.
- OpenTelemetry trace-context and semantic-convention behavior as implemented
  by the pinned Effect OTLP serializer and Collector `0.157.0` contract.
