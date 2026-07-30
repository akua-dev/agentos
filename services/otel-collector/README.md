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

The deployment has three explicit modes:

| Kustomize directory | Remote export | Local diagnostic archive |
| --- | --- | --- |
| `kubernetes/base` | disabled (`nop`) | off |
| `kubernetes/overlays/remote` | OTLP/HTTP | off |
| `kubernetes/overlays/local-diagnostics` | OTLP/HTTP | on |

Apply a mode in the Fleet's `agentos` namespace:

```console
kubectl apply -k services/otel-collector/kubernetes/base
```

The remote overlays require Secret `agentos-otel-remote` with:

- `endpoint`: the remote OTLP/HTTP base endpoint, including scheme;
- `headers.yaml`: a Secret-only Collector fragment containing the remote
  exporter header map.

For example, the uncommitted local input file for `headers.yaml` has this
shape:

```yaml
exporters:
  otlp_http/remote:
    headers:
      authorization: Bearer REDACTED
```

Create or provision that Secret with the Fleet's Secret manager. The
credential fragment is mounted read-only and merged by the Collector at
startup; it never appears in a ConfigMap, rendered Kustomize output, status
response, or local diagnostic record. `endpoint` is exposed to the Collector
as the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable. AgentOS
workloads use the complete standard `OTEL_*` SDK environment contract from
`ARCHITECTURE.md`.

The checked-in remote exporter uses OTLP/HTTP, TLS endpoints, gzip, a 10-second
attempt timeout, unbounded elapsed retry with a 30-second maximum backoff, and a
persistent queue of 2,048 requests with four consumers. Change endpoint,
Secret, queue, retry, signal, or protocol configuration by deploying reviewed
configuration; no AgentOS image rebuild is required. An OTLP/gRPC remote uses
the stable `otlp_grpc` exporter with the same Secret and queue rules.

## Storage and failure behavior

`file_storage/queue` lives at `/var/lib/otelcol/storage` on the Collector PVC.
Accepted batches survive a Collector process restart and pod rescheduling with
the retained claim. When the queue is full, new telemetry is refused or
dropped instead of blocking inference. A read-only/full PVC degrades persistent
buffering, not AI serving. Queue capacity is request-count based; size the PVC
from measured batch size and outage duration, and alert before either queue or
volume saturation.

The local-diagnostics overlay additionally enables the Collector `file`
exporter. That exporter is alpha in Collector `0.157.0`; its files are bounded
to eight 32 MiB backups and one day and are incident evidence, not a query
backend or durable source of truth. Export or inspect those files only through
the restricted observability runbook. Prompts, bodies, tool data, credentials,
provider identities, arbitrary error text, and content-bearing exception data
are removed before either exporter.

The remote backend owns searchable retention and access control. Collector
health checks only the local Collector process. Exporter health is visible in
Collector internal telemetry, but a remote outage does not make the Collector,
Mate, Crewmate, or Fleet AI Gateway unready.

## Network policy

Only same-namespace Pods labeled
`agentos.akua.dev/otel-client: "true"` may submit OTLP. Collector egress permits
DNS and standard OTLP/TLS destination ports. Kubernetes NetworkPolicy cannot
select an external FQDN; a Fleet that needs endpoint-specific egress must add
the CNI or cloud-firewall policy for its resolved remote backend. The policy
does not grant Agent workloads access to the remote telemetry credential.

Run the deployment checks with:

```console
bun test services/otel-collector/kubernetes/tests
```
