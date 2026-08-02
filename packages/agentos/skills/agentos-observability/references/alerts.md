# Backend-neutral alert specification

Tune thresholds from a measured baseline. Group only by bounded runtime, route,
request kind, model family, status class, error class, stream outcome,
resilience source/phase/outcome/cause/recovery, topology action/reason, runtime
action, workload profile/spec version, journal phase, and protocol.

| Alert | Portable condition | Group by | Response |
| --- | --- | --- | --- |
| Authentication failures | sustained `agentos.ai.provider.attempts` with error class `authentication` | runtime, route | [Runbook](runbooks.md#authentication-failures) |
| 429 quota/rate limit | rate of attempts with error class `rate_limit` above baseline | runtime, route, request kind | [Runbook](runbooks.md#quota-and-rate-limit) |
| 503 or overload | rate of attempts with error class `overload` or `unavailable` above baseline | runtime, route | [Runbook](runbooks.md#gateway-capacity-and-provider-overload) |
| Stream failures | stream outcome `client_disconnect`, `aborted`, or `upstream_error` above baseline | runtime, route, stream outcome | [Runbook](runbooks.md#stream-and-decompression-failures) |
| Call amplification | `agentos.ai.provider.attempts` / `agentos.ai.operations` exceeds the runtime baseline | runtime, route, request kind | [Runbook](runbooks.md#extension-and-session-amplification) |
| Collector export failure | Collector exporter failures or queue occupancy sustained above threshold | signal, exporter | [Runbook](runbooks.md#collector-or-backend-outage) |
| PVC pressure | Collector PVC usage crosses warning or critical capacity | namespace, workload | [Runbook](runbooks.md#collector-pvc-pressure) |
| missing telemetry | an expected active workload has no recent operations and no explicit disabled mode | runtime, route | [Runbook](runbooks.md#missing-telemetry) |
| conflicting workload plan | any `agentos.resilience.observations` with cause `conflicting_workload_plan` or repeated `invalid_workload_plan` | phase, cause, runtime action, workload profile | [Runbook](runbooks.md#invalid-or-conflicting-workload-plan) |
| retry exhausted or stuck operation | a terminal cause `retry_exhausted`, or operation duration/attempt class sustained beyond the runtime SLO without a terminal outcome | phase, cause, recovery, runtime action | [Runbook](runbooks.md#stuck-or-retry-exhausted-operation) |
| repaired operation loop | repeated `repair_forward` or repeated recovered-to-degraded transitions above the measured baseline | phase, cause, recovery, runtime action | [Runbook](runbooks.md#repaired-operation-loop) |
| protocol fallback degradation | ACP/A2A protocol fallback rate or `protocol_adapter` degradation above baseline | protocol, outcome, cause, recovery | [Runbook](runbooks.md#protocol-fallback-degradation) |
| unobserved resilience boundary | any `unobserved resilience` evidence for an expected active phase | source, phase, runtime action, protocol | [Runbook](runbooks.md#unobserved-resilience-boundary) |

Page only on sustained user impact or imminent bounded-queue/PVC exhaustion.
Use lower-severity tickets for isolated failures and backend-only telemetry
degradation.

Never group or page by agent, Assignment, proposal, operation, Pod, PVC,
session, or protocol ID, nor by workload, overlay, or render digest. Resolve an
individual incident through its protected trace only.
