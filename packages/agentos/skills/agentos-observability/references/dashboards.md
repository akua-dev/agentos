# Backend-neutral dashboard specification

Translate these panels into the selected metrics/traces/logs backend. Use only
the exact labels published for each metric in the Fleet telemetry contract;
being bounded does not by itself make an attribute legal for every metric. Do
not group metrics by pod UID, route slot, or any
request, trace, span, operation, attempt, session, provider-account, or
provider-request ID.

## Delegation and runtime resilience

- Boundary rate from `agentos.resilience.observations`, grouped only by source,
  phase, evidence, outcome, cause, and recovery.
- Terminal operation rate from `agentos.resilience.operations`, grouped by
  outcome, cause, and recovery.
- End-to-end latency percentiles from
  `agentos.resilience.operation.duration`, grouped by outcome and cause. Never
  use operation ID or retry attempt as a metric label.
- A phase funnel from topology decision through workload plan, render, apply,
  capacity, placement, readiness, provider, listener, protocol, native session,
  reconciliation, and outcome. Display explicit `unobserved` separately from
  zero traffic.
- Ratios for conflicting plans, repair-forward loops, retry exhaustion, and
  ACP/A2A fallback. Recovered fallback remains visible as degraded transport.
- First Mate topology decisions from `agentos.topology.decisions`, grouped by
  action and reason; semantic readiness from `agentos.readiness.checks`, grouped
  by component and outcome.

## AI operations

- Rate and success ratio from `agentos.ai.operations`, grouped by runtime,
  route, status class, and error class.
- Operation latency percentiles from `agentos.ai.operation.duration`, grouped
  by runtime and route.
- Calls per operation: rate of `agentos.ai.provider.attempts` divided by rate
  of `agentos.ai.operations`, grouped by runtime, route, and request kind.
- Provider-attempt latency from `agentos.ai.provider.duration`.
- Request-kind mix from `agentos.ai.provider.attempts`, highlighting
  compaction, memory extraction, memory consolidation, and extension calls;
  compaction may additionally use the bounded compaction-path label.

## Memory, access, protocol, usage and budget

- Memory operation rate and latency from `agentos.memory.operations` and
  `agentos.memory.operation.duration`, with candidate, attachment, attached-byte
  and index-age distributions from their published histograms. Never use query,
  topic or embedding values.
- Authorization, revocation, profile-reload, credential-release and authorized
  protocol panels from the `agentos.access.*` metrics, using only their exact
  operation, decision, reason, dependency, credential-outcome and protocol
  labels.
- ACP/A2A/HTTP/MCP operation, duration and fallback panels from
  `agentos.protocol.*`, using only name, operation, outcome and fallback where
  the individual metric permits them.
- Normalized tokens, modeled catalog cost and budget transitions from
  `agentos.ai.tokens`, `agentos.ai.cost` and `agentos.ai.budget.events`. Label
  cost as modeled and never present it as provider invoice truth.

## Gateway and streaming

- Route acquisition latency from `agentos.ai.route.acquire.duration`, split by
  route and status class.
- Time to provider headers from `agentos.ai.upstream.headers.duration`.
- Time to first byte from `agentos.ai.stream.first_byte.duration`.
- Stream lifetime from `agentos.ai.stream.duration`, split by route and stream
  outcome.
- Current streams from `agentos.ai.streams.active`.
- Completed stream rate from `agentos.ai.streams`; completed workload volume
  from `agentos.ai.stream.chunks` and `agentos.ai.stream.bytes`, split by route
  and stream outcome.
- Route lifecycle rate from `agentos.ai.route.events`, grouped by the bounded
  route operation and outcome labels. Compare it with current reservations from
  `agentos.ai.route.reservations.active` to detect leaked leases.
- Quota freshness from `agentos.ai.quota.observation.age`, split only by the
  bounded `agentos.ai.quota.stale` boolean.
- Quota refresh outcomes from `agentos.ai.quota.refreshes`, grouped only by the
  bounded quota outcome and error class.

## Correlated traces and logs

Provide a protected trace search by trace ID, operation ID, attempt ID, or
provider request ID. For resilience operations, also support protected lookup
by Agent, Assignment, proposal, Pod, PVC, native-session, and protocol IDs, plus
workload spec/overlay and render digest. Show the root
`agentos.resilience.operation`, its `agentos.resilience.<phase>` children,
timestamps, safe attributes, and registry-defined log or audit projections such
as the privacy-safe `ai_gateway_failure` record. Filter only on attributes
declared by that exact event. Never promote protected identifiers or digests to
metric labels or shared dashboard variables, and never store raw YAML, prompts,
reasoning, credentials, or memory content.

## Collector health

Use Collector self-telemetry for receiver accepted/refused counts, exporter
sent/failed counts, sending-queue size/capacity, retry activity, process memory,
and dropped spans/metrics/logs. Add Kubernetes PVC capacity/usage and pod
restart/readiness panels. Separate:

The AgentOS pipeline metrics may additionally show bounded signal, stage,
outcome and reason. Backend-native Collector metrics remain backend contracts
and do not authorize new AgentOS labels.

- inference serving healthy, telemetry healthy;
- inference serving healthy, telemetry degraded;
- inference degraded, telemetry healthy; and
- both degraded.

## Missing telemetry

Compare expected active Fleet workloads with recent
`agentos.ai.operations`. A missing series is not zero traffic until workload
activity, `OTEL_SDK_DISABLED`, Collector receiver health, and backend ingest are
checked.
