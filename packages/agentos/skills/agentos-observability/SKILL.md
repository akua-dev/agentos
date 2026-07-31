---
name: agentos-observability
description: Diagnose AgentOS Fleet AI failures and performance with privacy-safe OpenTelemetry evidence across Pi, Codex, Mate extensions, the optional AI Gateway, Kubernetes, the Fleet Collector, and a remote OTLP backend. Use for provider errors, quota or routing failures, broken streams, extension-versus-runtime comparisons, missing telemetry, latency or call amplification, and post-incident verification.
---

# AgentOS observability

Establish where an AI attempt failed without inspecting AI content, credentials,
provider identities, or arbitrary error bodies. Treat serving health and
telemetry export health as independent signals.

## Workflow

1. Resolve and record the exact Kubernetes context, namespace, workload, pod,
   container, image digest, runtime, model, route, and session state. Pass
   `--context` and `--namespace` explicitly to every Kubernetes command.
2. Check workload readiness, restart count, current runtime process, and
   Gateway `/healthz`/`/readyz` before changing anything. A Collector or backend
   outage must not make inference unready.
3. Inspect the loaded Pi extension catalog or Codex config. Never infer
   activation from files merely existing on disk.
4. If extension involvement is plausible, run the paired procedure in
   [references/control-matrix.md](references/control-matrix.md).
   Do not declare root cause from an unpaired `-ne` or one-off success.
5. Follow one attempt from `agentos.ai.operation` or a Codex native turn span
   through `agentos.ai.provider.attempt`, `ai-gateway.request`,
   `ai-gateway.route.acquire`, `ai-gateway.upstream`, and
   `ai-gateway.stream`. Use trace/request/attempt IDs only for protected
   correlation, never as metric labels.
6. Compare bounded metrics with
   [references/dashboards.md](references/dashboards.md), then select the
   matching [alert](references/alerts.md) and
   [runbook](references/runbooks.md).
7. If spans are absent, walk outward: runtime SDK/config, pod `OTEL_*`
   variables, Collector receive/export self-telemetry, persistent queue/PVC,
   then the remote backend. Do not restart serving workloads to repair
   telemetry.
8. Report observed facts, ruled-out layers, remaining hypotheses, exact
   correlation window, and any rollback. Keep prompts, bodies, headers,
   credentials, provider account data, memory content, and raw exceptions out
   of the report.

## Guardrails

- Prefer read-only inspection and ephemeral controlled trials.
- Keep same pod, model, route, session state, prompt fixture, and trial count
  when comparing extension states.
- Use `pi -ne -e
  /opt/agentos/packages/agentos/extensions/agentos-observability.ts` for the
  explicit no-discovery control. `-ne` alone also removes observability and
  cannot produce the evidence needed for comparison.
- Require explicit authority before a rollout, exporter change, account
  change, or extension disable. Change only the selected extension and verify
  the resulting pod template, image, readiness, restarts, and live session.
- Never enable `log_user_prompt`; the Codex bridge must keep it false.
- Never enable the local diagnostic archive casually. It is bounded,
  temporary, access-controlled evidence, not a query backend.
