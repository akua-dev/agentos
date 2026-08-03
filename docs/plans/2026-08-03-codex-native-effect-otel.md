# Native Codex OpenTelemetry completion plan

**Issue:** #61
**Base:** `bce7839e09c5ff0edb79f2796959116f6c0a1bbb`
**Constraint:** all AgentOS TypeScript and TypeScript tests are Effect-native; Kustomize remains the deployment authority.

## Outcome

Make the Fleet OTel contract reach the AgentOS-pinned Codex `0.144.5`
process in a rendered Crewmate workload, preserve Codex-owned telemetry and
W3C propagation, normalize its privacy-safe API-attempt evidence at the
Collector, and prove logs, traces, and metrics with the real pinned binary.

## Frozen audit findings

- `prepare-home` already reconciles a private, atomic native Codex `[otel]`
  block and forces `log_user_prompt = false` while preserving unrelated TOML.
- The observability Kustomize component adds `OTEL_*` only to the runtime
  container. The `prepare-home` init container therefore cannot enable native
  Codex exporters in the rendered workload.
- Pinned Codex tag `rust-v0.144.5` resolves to upstream commit
  `87db9bc18ba5bc82c1cb4e4381b44f693ee35623`. It supports explicit OTLP HTTP
  JSON/binary and gRPC exporters, emits logs/traces/metrics, and does not read
  the generic OTel exporter environment by itself.
- Native Codex resources contain its service/version plus `env`; the Collector
  must add Fleet, cluster, namespace, workload, Pod, container, runtime, and
  runtime-version identity from deployment-controlled state.
- Native `codex.api_request` log/trace events include status, duration,
  `error.message`, and `auth.request_id`. The current contract allowlist drops
  the raw unsafe fields without first projecting bounded status/error and the
  capped protected upstream request ID.

## Tasks

1. Extend rendered Crewmate manifest tests first to require the complete OTel
   bridge environment on both `prepare-home` and the runtime container, plus
   deployment-controlled Codex runtime labels for Collector enrichment.
2. Extend Collector configuration tests first to require resource enrichment
   and a Codex-native normalization processor before privacy/allowlisting on
   all three pipelines and every overlay.
3. Add a real-process Effect integration test for the exact pinned `codex`
   executable. Run one deterministic Responses turn against an Effect HTTP
   fixture and capture native OTLP/HTTP JSON logs, traces, and metrics. Prove
   prompt/credential/header privacy, upstream request ID, status/duration,
   restart persistence, explicit disable, and bounded Collector-outage delay.
4. Patch the Kustomize observability component, Crewmate labels, and Fleet
   Collector processors until the failing contracts and pinned Collector
   `validate` pass. Project only bounded AgentOS fields, then remove raw Codex
   error/auth/content attributes at the existing allowlist boundary.
5. Extend the opt-in Kubernetes Effect smoke to run the real pinned Codex binary
   in an isolated Codex-labelled Pod through the real Collector and verifies
   final sink identity/privacy across logs, traces, and metrics without
   changing the live `agentos` namespace.
6. Record compatibility and verification evidence, run focused suites,
   Kustomize renders, pinned Collector validation, the real Codex matrix, full
   `bun run check`, exact-head PR CI, and merged-main CI before closing #61.

## Verification commands

```console
bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism packages/agentos/runtime/tests/codex-otel.effect.test.ts packages/agentos/runtime/tests/codex-native-otel.effect.test.ts packages/agentos/resources/crewmates/default/kubernetes/tests/manifest.effect.test.ts services/otel-collector/kubernetes/tests/config.effect.test.ts
AGENTOS_RUN_OTEL_K8S_E2E=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/tests/kubernetes-smoke.effect.test.ts
kubectl kustomize packages/agentos/resources/crewmates/default/kubernetes/base
kubectl kustomize services/otel-collector/kubernetes/base
kubectl kustomize services/otel-collector/kubernetes/overlays/remote
kubectl kustomize services/otel-collector/kubernetes/overlays/remote-grpc
kubectl kustomize services/otel-collector/kubernetes/overlays/local-diagnostics
bun run effect:check
bun run check
git diff --check
```
