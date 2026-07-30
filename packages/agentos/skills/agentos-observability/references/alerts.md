# Backend-neutral alert specification

Tune thresholds from a measured baseline. Group only by bounded runtime, route,
request kind, model family, status class, error class, and stream outcome.

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

Page only on sustained user impact or imminent bounded-queue/PVC exhaustion.
Use lower-severity tickets for isolated failures and backend-only telemetry
degradation.
