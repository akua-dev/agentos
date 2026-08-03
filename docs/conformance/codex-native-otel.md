# Pinned Codex native OpenTelemetry conformance

AgentOS validates native Codex telemetry against `codex-cli 0.144.5`. The
corresponding upstream tag is `rust-v0.144.5`; its peeled commit is
`87db9bc18ba5bc82c1cb4e4381b44f693ee35623`. This is the release source used
for the compatibility review and real-process tests. AgentOS does not carry a
Codex fork.

## Supported Fleet bridge

| Fleet input | Pinned Codex configuration | Behavior |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and signal endpoints | `exporter`, `trace_exporter`, `metrics_exporter` endpoints | A generic HTTP endpoint receives `/v1/logs`, `/v1/traces`, or `/v1/metrics`; a signal endpoint is used exactly. |
| `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` | `otlp-http.protocol = "binary"` | Supported and used by the released workload. |
| `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` | `otlp-http.protocol = "json"` | Supported and exercised by the pinned real-process test. |
| `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` | `otlp-grpc` | Supported by the bridge and pinned configuration parser. |
| Generic or signal headers | Native exporter header map | Non-credential headers are written only to mode-`0600` config. If a credential-like header would need persistence, AgentOS fails safe by setting every native exporter to `none`; it never writes the value. |
| Signal exporter selectors | Three explicit native exporters | `otlp` enables the selected signal; `none` disables it. Unsupported values fail preparation without partially rewriting config. |
| `OTEL_SDK_DISABLED=true` | All three exporters set to `none` | Explicit Fleet disable removes stale exporters while keeping `log_user_prompt=false`. |
| `deployment.environment.name` resource attribute | `otel.environment` | Bounded environment value is mapped natively. Other Fleet/Kubernetes resources are added by the Collector. |

`OTEL_EXPORTER_OTLP_COMPRESSION`, `OTEL_EXPORTER_OTLP_TIMEOUT`, sampler and
propagator settings remain on the runtime process environment. Pinned Codex's
native `[otel]` schema has no equivalent fields for the AgentOS bridge to
persist. W3C trace-context propagation is native and is exercised across the
real provider request.

## Analytics and metrics

AgentOS always writes `metrics_exporter` explicitly. This replaces Codex
`0.144.5`'s implicit Statsig metrics exporter and prevents duplicate/default
metrics export. Codex's separate `[analytics]` product preference is preserved
as user-owned configuration. In this pinned release that preference is also
the gate for every metrics exporter: an explicit `analytics.enabled=false`
therefore suppresses the configured Fleet metrics exporter, while native logs
and traces remain available. A fresh `codex exec` configuration uses Codex's
documented/default enabled state and exports all three Fleet signals. Decoupling
product analytics from explicit OTLP metrics belongs upstream; AgentOS will not
fork Codex to change it.

## Collector normalization and privacy

Codex emits native service name/version plus a small `env` resource. The Fleet
Collector attaches Fleet, cluster, namespace, workload, Pod, container,
runtime, and runtime-version identity from Collector environment and
Kubernetes metadata. For `codex.api_request`, it projects only:

- request kind `main`;
- bounded success/client/server/error status class;
- bounded `none`, authentication, rate-limit, overload, unavailable, or
  unknown error class;
- HTTP response status;
- an upstream request ID capped at 128 characters when available.

Request duration remains in `codex.api_request.duration_ms`. Normalization runs
before the shared privacy processors and exact allowlists. Raw `error.message`,
`auth.request_id`, prompts, message/log bodies, tool arguments/results,
authorization material, arbitrary native fields, and exporter header values
are removed before the sink.

## Executable evidence

- `packages/agentos/runtime/tests/codex-otel.effect.test.ts` covers atomic,
  idempotent merge/disable behavior, mode `0600`, supported protocols, endpoint
  precedence, and credential-header fail-safe behavior.
- `packages/agentos/runtime/tests/codex-native-otel.effect.test.ts` runs the
  exact pinned executable against an Effect HTTP provider and OTLP fixture,
  including a retrying API attempt, W3C propagation, all three signals, and
  content/credential absence.
- `services/otel-collector/tests/e2e.effect.test.ts` passes realistic native
  Codex payloads through the pinned Collector image and verifies the final
  privacy-bounded sink.
- `services/otel-collector/tests/kubernetes-smoke.effect.test.ts` builds the
  current AgentOS image in an isolated Kind cluster, installs the pinned Codex
  tool, runs a real Codex workload through the Fleet Collector, replaces the
  Pod over its retained PVC, and runs another successful turn while the
  Collector is absent.

All TypeScript production and test paths above are Effect-native. Kustomize is
the deployment authority.
