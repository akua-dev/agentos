# Fleet OpenTelemetry Collector

This optional service is the vendor-neutral OTLP gateway for one AgentOS Fleet.
It is deliberately separate from the Fleet AI Gateway: telemetry failure,
storage pressure, or a remote backend outage cannot share an inference process,
volume, liveness probe, or readiness decision.

The base renders a single Collector Contrib `0.157.0` StatefulSet, a stable
OTLP Service, metadata-only Kubernetes RBAC, a selected-client NetworkPolicy,
and a retained 5 GiB PVC. It accepts OTLP/gRPC on 4317 and OTLP/HTTP on 4318.
The image is pinned to the official multi-architecture digest and the
configuration is validated against that exact binary in tests.

## Modes

Choose exactly one Kustomize directory for a Fleet:

| Kustomize directory | Remote export | Local diagnostic archive |
| --- | --- | --- |
| `kubernetes/base` | disabled (`nop`) | off |
| `kubernetes/overlays/remote` | OTLP/HTTP | off |
| `kubernetes/overlays/remote-grpc` | OTLP/gRPC | off |
| `kubernetes/overlays/local-diagnostics` | OTLP/HTTP | on |

Apply the selected mode in the Fleet's `agentos` namespace:

```console
kubectl apply -k services/otel-collector/kubernetes/base
```

Changing between these reviewed overlays changes export behavior without an
AgentOS image rebuild. The local-diagnostics mode extends the HTTP remote mode;
it is not a standalone local-only mode.

## Remote credentials and endpoints

Every remote mode requires Secret `agentos-otel-remote` with:

- `endpoint`: `https://collector.example.test` for OTLP/HTTP, or
  `collector.example.test:4317` for OTLP/gRPC;
- `headers.yaml`: a Secret-only Collector fragment containing the header map
  for the selected exporter component.

For example, the uncommitted local input for the HTTP Secret key has this
shape:

```yaml
exporters:
  otlp_http/remote:
    headers:
      authorization: Bearer REDACTED
```

Use `otlp_grpc/remote` as the exporter key for the gRPC overlay. Provision the
Secret with the Fleet Secret manager. The fragment is mounted read-only and
merged by the Collector at startup; it never appears in a ConfigMap, rendered
Kustomize output, status response, or local diagnostic record. Do not inspect
or copy the Secret with commands that print its data.

HTTP requires an `https://` endpoint. The gRPC exporter is secure by default;
do not add `tls.insecure: true`. A private CA requires a reviewed overlay that
mounts only that CA from a Secret and sets the exporter's `tls.ca_file`.

Both remote exporters use gzip, a 10-second attempt timeout, unbounded elapsed
retry with a 30-second maximum backoff, and a persistent queue of 2,048
requests with four consumers. Queue writes do not wait for export and do not
block on overflow. There is deliberately no in-memory fallback: disk failure
causes observable telemetry loss instead of adding memory pressure to
inference.

## Fleet configuration surface

Fleet configuration is deployment-time Kustomize input, not image state:

| Setting | Checked-in default | How to change it |
| --- | --- | --- |
| Export enabled/protocol | disabled | select `base`, `remote`, or `remote-grpc` |
| Endpoint and headers | no remote credential in base | provision `agentos-otel-remote` |
| TLS | secure remote transport | patch exporter TLS settings and Secret mounts |
| Enabled signals | traces, metrics, logs | patch the selected overlay pipelines |
| Trace sampling | 100% | patch `AGENTOS_OTEL_TRACE_SAMPLING_PERCENTAGE` in the StatefulSet |
| Queue capacity | 2,048 requests, 512 MiB storage DB | patch `sending_queue.queue_size` and `file_storage.max_size` together |
| Queue PVC | retained 5 GiB | patch the base volume claim template before Fleet creation; expand the live PVC separately |
| Local diagnostics | off | select `local-diagnostics` |
| Diagnostic retention | 32 MiB files, 8 backups, 1 day, 512 MiB PVC | patch the file exporter and dedicated PVC together |

Sampling uses proportional trace-ID sampling and fails closed on an invalid
percentage. Resource attributes from `OTEL_RESOURCE_ATTRIBUTES` are detected
for every signal without replacing attributes already supplied by a workload.
AgentOS workloads use the complete standard `OTEL_*` SDK environment contract
from `ARCHITECTURE.md`.

The governed provider plane adds `agentos-egress-authz` and `github-broker` as
selected OTLP clients. Access spans may retain protected Mate, Assignment,
decision and profile correlation, while access metrics are restricted to the
finite route, adapter, provider, decision, dependency, credential and terminal
outcome vocabularies. The Collector drops those protected identifiers from
metrics even if a faulty producer attempts to attach them.

## Storage and failure behavior

`file_storage/queue` lives at `/var/lib/otelcol/storage` on the Collector PVC.
It uses synchronous writes, a 1-second storage timeout, a 512 MiB per-database
limit, startup/rebound compaction, and a retained claim. Accepted batches
survive Collector process restart and pod rescheduling, then drain when the
remote backend recovers.

When the 2,048-request queue, storage database, or PVC is full or read-only,
new telemetry is refused or dropped and `otelcol_exporter_enqueue_failed_*`
increases. An unreachable or unauthorized backend increases
`otelcol_exporter_send_failed_*`; retryable accepted requests stay on disk.
None of these conditions block inference or use the AI Gateway data volume.

The local-diagnostics overlay writes to a separate
`agentos-otel-diagnostics` 512 MiB PVC at
`/var/lib/otelcol-diagnostics`. The Collector `file` exporter is alpha in
`0.157.0`; its current file plus eight 32 MiB backups are bounded by rotation,
and the PVC is the independent hard storage bound. The archive is incident
evidence, not a query backend or durable source of truth. Prompts, bodies, tool
data, credentials, provider identities, arbitrary error text, and
content-bearing exception data are removed before either exporter.

## Status and network access

Only same-namespace Pods labeled
`agentos.akua.dev/otel-client: "true"` may submit OTLP. Only same-namespace
Pods labeled `agentos.akua.dev/observability-admin: "true"` may access:

- `GET :13133/healthz`, whose complete healthy body is `{"status":"ok"}`;
- `GET :8888/metrics`, which exposes Collector internal telemetry.

The pprof listener is loopback-only. Health reports the local Collector
process, not the remote backend; a remote outage must not make the Collector,
Mate, Crewmate, or Fleet AI Gateway unready. Exporter health comes from the
internal metrics described in [RUNBOOK.md](RUNBOOK.md).

Collector egress permits DNS and standard OTLP/TLS destination ports.
Kubernetes NetworkPolicy cannot select an external FQDN, and AgentOS does not
blanket-block Mate internet access. Endpoint-specific restrictions belong in
the CNI/cloud firewall and the external API authorization path; no Agent
workload receives the telemetry credential.

## Verification

Run manifest/configuration tests:

```console
bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/kubernetes/tests
```

Run the live Collector outage and saturation suite when Docker is available:

```console
AGENTOS_RUN_OTEL_E2E=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/tests/e2e.effect.test.ts
```

Run the disposable Kubernetes smoke when Docker, Kind, and kubectl are
available. It creates and always deletes a uniquely named `agentos-otel-*`
cluster:

```console
AGENTOS_RUN_OTEL_K8S_E2E=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/tests/kubernetes-smoke.effect.test.ts
```
