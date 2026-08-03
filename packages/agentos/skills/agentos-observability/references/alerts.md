# Backend-neutral alert specification

Tune thresholds from a measured baseline. Group only by the exact labels
published for the metric used by the alert; bounded attributes are not a shared
label pool.

| Alert | Portable condition | Group by | Response |
| --- | --- | --- | --- |
| Authentication failures | sustained `agentos.ai.provider.attempts` with error class `authentication` | runtime, route | [Runbook](runbooks.md#authentication-failures) |
| 429 quota/rate limit | rate of attempts with error class `rate_limit` above baseline | runtime, route, request kind | [Runbook](runbooks.md#quota-and-rate-limit) |
| 503 or overload | rate of attempts with error class `overload` or `unavailable` above baseline | runtime, route | [Runbook](runbooks.md#gateway-capacity-and-provider-overload) |
| Stream failures | `agentos.ai.stream.chunks` with outcome `client_disconnect`, `aborted`, or `upstream_error` above baseline | route, stream outcome | [Runbook](runbooks.md#stream-and-decompression-failures) |
| Call amplification | `agentos.ai.provider.attempts` / `agentos.ai.operations` exceeds the runtime baseline | runtime, route, request kind | [Runbook](runbooks.md#extension-and-session-amplification) |
| Collector export failure | Collector exporter failures or queue occupancy sustained above threshold | signal, exporter | [Runbook](runbooks.md#collector-or-backend-outage) |
| PVC pressure | Collector PVC usage crosses warning or critical capacity | namespace, workload | [Runbook](runbooks.md#collector-pvc-pressure) |
| missing telemetry | an expected active workload has no recent operations and no explicit disabled mode | runtime, route | [Runbook](runbooks.md#missing-telemetry) |
| conflicting workload plan | any `agentos.resilience.observations` with cause `conflicting_workload_plan` or repeated `invalid_workload_plan` | phase, cause, recovery | [Runbook](runbooks.md#invalid-or-conflicting-workload-plan) |
| retry exhausted | `agentos.resilience.operations` with terminal cause `retry_exhausted` above zero | outcome, cause, recovery | [Runbook](runbooks.md#stuck-or-retry-exhausted-operation) |
| slow resilience operation | `agentos.resilience.operation.duration` sustained beyond the runtime SLO | outcome, cause | [Runbook](runbooks.md#stuck-or-retry-exhausted-operation) |
| repaired operation loop | repeated `repair_forward` or repeated recovered-to-degraded transitions above the measured baseline | phase, cause, recovery | [Runbook](runbooks.md#repaired-operation-loop) |
| protocol fallback degradation | `agentos.protocol.fallbacks` or resilience `protocol_adapter` degradation above baseline | protocol name/fallback for protocol metrics; phase/cause/recovery for resilience metrics | [Runbook](runbooks.md#protocol-fallback-degradation) |
| unobserved resilience boundary | any `unobserved` resilience evidence for an expected active phase | source, phase, evidence | [Runbook](runbooks.md#unobserved-resilience-boundary) |

Page only on sustained user impact or imminent bounded-queue/PVC exhaustion.
Use lower-severity tickets for isolated failures and backend-only telemetry
degradation.

Never group or page by agent, Assignment, proposal, operation, Pod, PVC,
session, or protocol ID, nor by workload, overlay, or render digest. Resolve an
individual incident through its protected trace only.
