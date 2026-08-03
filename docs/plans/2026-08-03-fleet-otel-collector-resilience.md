# Fleet OTLP Collector resilience implementation plan

**Issue:** #58
**Base:** `fe2d895c434af4dc47e68713159ff2da3098e75b`
**Constraint:** every AgentOS TypeScript path is Effect-native; Kustomize remains the deployment authority.

## Outcome

Finish the Fleet-local Collector as a failure-isolated OTLP gateway with a
persistent bounded queue, configurable HTTP or gRPC remote export, an optional
hard-bounded diagnostic archive, privacy-safe operational status, and live
Docker and Kubernetes resilience evidence.

## Tasks

1. Extend `services/otel-collector/kubernetes/tests/*.effect.test.ts` first to
   require resource detection, trace sampling, explicit receiver limits,
   bounded file storage, fail-open queue settings, admin-only health/metrics,
   HTTP and gRPC remote modes, Secret-only credentials, and a separate bounded
   diagnostics PVC.
2. Update the Kustomize base and overlays until those tests and Collector
   `0.157.0 validate` pass. Keep remote credentials exclusively in the mounted
   Secret fragment and keep inference readiness independent from telemetry.
3. Extend `services/otel-collector/tests/e2e.effect.test.ts` and its Effect test
   sink first for malformed and oversized OTLP, exporter authentication
   failure, read-only/full queue storage, and live local archive rotation.
4. Add an opt-in Effect-native Kind smoke test that applies the real manifests,
   sends traces, metrics, and logs from Pi-, Codex-, and AI-Gateway-labelled
   Jobs, proves inference remains healthy while the Collector is scaled down,
   and proves the same retained PVC is reattached after recreation.
5. Document exact queue/backoff/data-loss behavior, configuration patches,
   archive byte/time bounds, internal metrics and alert thresholds, and the
   destructive boundaries of PVC recovery.
6. Verify focused tests, all Kustomize renders, pinned Collector validation,
   live Docker E2E, disposable Kind E2E with cleanup, the full repository
   check, PR checks, and the merged default-branch check before closing #58.

## Verification commands

```console
bun test services/otel-collector/kubernetes/tests
AGENTOS_RUN_OTEL_E2E=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/tests/e2e.effect.test.ts
AGENTOS_RUN_OTEL_K8S_E2E=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism services/otel-collector/tests/kubernetes-smoke.effect.test.ts
kubectl kustomize services/otel-collector/kubernetes/base
kubectl kustomize services/otel-collector/kubernetes/overlays/remote
kubectl kustomize services/otel-collector/kubernetes/overlays/remote-grpc
kubectl kustomize services/otel-collector/kubernetes/overlays/local-diagnostics
bun run check
git diff --check
```
