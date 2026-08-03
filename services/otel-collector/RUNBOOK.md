# Fleet Collector runbook

Use this runbook when Fleet telemetry is delayed, refused, or dropped. The
Collector is failure-isolated from inference: do not restart the AI Gateway or
a Mate merely because telemetry export is unhealthy.

## Alerts

Scrape port 8888 only from a same-namespace workload labeled
`agentos.akua.dev/observability-admin: "true"`. Apply these thresholds per
Fleet and exporter, separately for spans, metric points, and log records where
the metric has signal-specific variants:

| Condition | Warning | Critical | Meaning |
| --- | --- | --- | --- |
| `otelcol_exporter_queue_size / otelcol_exporter_queue_capacity` | above 70% for 10 minutes | above 90% for 5 minutes | remote export is not keeping up |
| increase in `otelcol_exporter_enqueue_failed_*` | any increase | sustained increase for 5 minutes | queue/storage rejected new telemetry; data loss occurred |
| increase in `otelcol_exporter_send_failed_*` | sustained for 10 minutes | sustained with queue above 70% | remote endpoint, TLS, authorization, or availability failure |
| increase in `otelcol_receiver_refused_*` | any increase | sustained for 5 minutes | memory pressure or malformed/oversized input |
| queue PVC usage | above 70% for 10 minutes | above 85% for 5 minutes | persistent queue is approaching its hard bound |
| diagnostics PVC usage | above 80% for 10 minutes | above 90% for 5 minutes | rotation or retention is not reclaiming space |
| StatefulSet ready replicas | below 1 for 5 minutes | below 1 for 15 minutes | collection is unavailable; inference should remain healthy |

Use `clamp_min(otelcol_exporter_queue_capacity, 1)` in the queue-ratio query.
The exact Kubernetes volume metrics depend on the cluster monitoring stack;
match the PVC names `storage-agentos-otel-collector-0` and
`agentos-otel-diagnostics`. Page on data loss, not merely on a short retry.

## Triage without exposing credentials

Check local health, rollout, PVCs, events, and Collector logs:

```console
kubectl -n agentos get statefulset agentos-otel-collector
kubectl -n agentos get pod,pvc -l app.kubernetes.io/name=agentos-otel-collector
kubectl -n agentos describe statefulset agentos-otel-collector
kubectl -n agentos logs statefulset/agentos-otel-collector --since=30m
kubectl -n agentos port-forward service/agentos-otel-collector 13133:13133 8888:8888
```

After port-forwarding, inspect only the static health response and internal
metrics:

```console
curl --fail http://127.0.0.1:13133/healthz
curl --fail http://127.0.0.1:8888/metrics
```

Never run `kubectl get secret agentos-otel-remote -o yaml`, print mounted
`headers.yaml`, or paste authorization failures with raw headers. Status and
metrics must not contain the credential; Collector logs may identify a remote
status code but must not log the header value.

Interpret the evidence in this order:

1. A failing `/healthz` or absent replica is a local Collector/config/storage
   problem.
2. A healthy Collector with rising `send_failed` is a remote endpoint, TLS,
   credential, or authorization problem.
3. A rising queue with no enqueue failures is buffered delay and may recover.
4. Any `enqueue_failed` increase proves telemetry loss; record the affected
   interval even after recovery.
5. Receiver refusals with a stable queue point to invalid/oversized payloads or
   Collector memory pressure.

## Recovery

For a remote outage, restore the backend or route and let the persisted queue
drain. Do not delete the pod repeatedly and never delete the queue PVC. Confirm
the queue ratio returns toward zero and `send_failed` stops increasing.

For expired or revoked authorization, rotate `agentos-otel-remote` through the
Fleet Secret manager, then restart only the Collector so it rereads the mounted
fragment:

```console
kubectl -n agentos rollout restart statefulset/agentos-otel-collector
kubectl -n agentos rollout status statefulset/agentos-otel-collector
```

For queue PVC pressure, first restore export. If backlog size is legitimate,
expand the bound PVC through the storage class and increase
`file_storage.max_size` only in a reviewed Kustomize change. Keep the database
below the PVC capacity. If the filesystem becomes read-only or the storage DB
cannot open, preserve a volume snapshot before repair; do not fall back to an
in-memory queue.

For diagnostic PVC pressure, switch back to the matching remote overlay to
stop new local writes, preserve the PVC for the incident, and inspect rotation
configuration. Do not mount this PVC into the AI Gateway or Agent pods.

For an invalid configuration, restore the last reviewed Kustomize overlay and
roll out the StatefulSet. Validate the replacement against the pinned
Collector binary and run the manifest tests before applying it.

## Recovery confirmation

Recovery is complete when:

- the StatefulSet has one ready replica and `/healthz` returns exactly
  `{"status":"ok"}`;
- `send_failed`, `enqueue_failed`, and receiver-refusal counters stop
  increasing;
- the queue drains below 70% and both PVCs remain below their warning levels;
- a fresh safe OTLP event reaches the remote backend;
- inference remained available throughout, or any separate inference incident
  has its own cause and timeline.
