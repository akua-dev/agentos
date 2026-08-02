# Backend-neutral dashboard specification

Translate these panels into the selected metrics/traces/logs backend. Use only
bounded contract attributes: runtime, route, provider family, request kind,
model family, session state, stream mode/outcome, status class, error class,
and quota stale state. Do not group metrics by pod UID, route slot, or any
request, trace, span, operation, attempt, session, provider-account, or
provider-request ID.

## Delegation and runtime resilience

- Boundary rate from `agentos.resilience.observations`, grouped only by source,
  phase, outcome, cause, recovery, topology action/reason, runtime action,
  workload profile/spec version, journal phase, and protocol.
- Terminal operation rate from `agentos.resilience.operations`, grouped by
  outcome, cause, recovery, and runtime action.
- End-to-end latency percentiles from
  `agentos.resilience.operation.duration`, grouped by outcome and runtime
  action. Overlay the bounded retry-attempt class; never use operation ID.
- A phase funnel from topology decision through workload plan, render, apply,
  capacity, placement, readiness, provider, listener, protocol, native session,
  reconciliation, and outcome. Display explicit `unobserved` separately from
  zero traffic.
- Ratios for conflicting plans, repair-forward loops, retry exhaustion, and
  ACP/A2A fallback. Recovered fallback remains visible as degraded transport.

## AI operations

- Rate and success ratio from `agentos.ai.operations`, grouped by runtime,
  route, status class, and error class.
- Operation latency percentiles from `agentos.ai.operation.duration`, grouped
  by runtime and route.
- Calls per operation: rate of `agentos.ai.provider.attempts` divided by rate
  of `agentos.ai.operations`, grouped by runtime, route, and request kind.
- Provider-attempt latency from `agentos.ai.provider.duration`.
- Request-kind mix from `agentos.ai.provider.attempts`, highlighting
  compaction, memory extraction, memory consolidation, and extension calls.

## Gateway and streaming

- Route acquisition latency from `agentos.ai.route.acquire.duration`, split by
  status and error class.
- Time to provider headers from `agentos.ai.upstream.headers.duration`.
- Time to first byte from `agentos.ai.stream.first_byte.duration`.
- Stream lifetime from `agentos.ai.stream.duration`, split by stream outcome.
- Current streams from `agentos.ai.streams.active`.
- Completed workload volume from `agentos.ai.stream.chunks` and
  `agentos.ai.stream.bytes`, split by stream outcome.
- Quota freshness from `agentos.ai.quota.observation.age`, split only by the
  bounded `agentos.ai.quota.stale` boolean.

## Correlated traces and logs

Provide a protected trace search by trace ID, operation ID, attempt ID, or
provider request ID. For resilience operations, also support protected lookup
by Agent, Assignment, proposal, Pod, PVC, native-session, and protocol IDs, plus
workload spec/overlay and render digest. Show the root
`agentos.resilience.operation`, its `agentos.resilience.<phase>` children,
timestamps, safe attributes, and the privacy-safe `ai_gateway_failure` record.
Never promote these identifiers or digests to metric labels or shared dashboard
variables, and never store raw YAML, prompts, reasoning, credentials, or memory
content.

## Collector health

Use Collector self-telemetry for receiver accepted/refused counts, exporter
sent/failed counts, sending-queue size/capacity, retry activity, process memory,
and dropped spans/metrics/logs. Add Kubernetes PVC capacity/usage and pod
restart/readiness panels. Separate:

- inference serving healthy, telemetry healthy;
- inference serving healthy, telemetry degraded;
- inference degraded, telemetry healthy; and
- both degraded.

## Missing telemetry

Compare expected active Fleet workloads with recent
`agentos.ai.operations`. A missing series is not zero traffic until workload
activity, `OTEL_SDK_DISABLED`, Collector receiver health, and backend ingest are
checked.
