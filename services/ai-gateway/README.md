# Fleet AI Gateway

An optional, authenticated Fleet-local service for sharing a Captain-approved
pool of OpenAI Codex subscriptions across Agent Pods. It keeps sessions sticky,
routes with quota headroom, refreshes server-owned OAuth chains and streams the
provider's real response back to the native harness.

Direct per-Agent provider login remains the complete minimal and recovery path.
For a delegation-ready Fleet, install this service only when pooled
subscription capacity is worth the Captain-approved credential authority and
additional service lifecycle. The operator workflow lives in
`$agentos-ai-gateway`; the stable boundary lives in `ARCHITECTURE.md`.

The supported capacity order is direct per-Agent OAuth, this in-cluster
multi-subscription Gateway, a mixed posture with only selected pooled clients,
and an external Cloudflare Worker last. AgentOS-only Fleets should use the
in-cluster or mixed posture: AgentOS can operate the service natively and keep
the complete privacy-bounded AI path in its OpenTelemetry topology. Never chain
a Cloudflare Worker through this service.

Shared selection, session, lease, response classification, persistent routing
transitions, Responses protocol, header sanitation and streaming semantics
come from the full-commit-pinned MIT-licensed
[`akua-dev/codex-router`](https://github.com/akua-dev/codex-router) root Git
package. AgentOS imports its `/core`, `/codex`, and `/bun` entry points and
supplies only Fleet OAuth-vault integration, quota observations, protected
rejection diagnostics, health, OpenTelemetry and deployment wiring. Shared
routing behavior changes upstream first and the Git commit pin is then updated
here; this package does not carry an independent policy fork. It does not
capture transcripts, wrap harness commands or silently change models/providers.

This is deliberately not a universal AgentOS proxy. Git, PostgreSQL,
Kubernetes, Herdr, registries and other provider tools retain their native
interfaces. Account login and refresh use the locked atomic OAuth vault;
session, lease and block transitions use the canonical Effect Bun/SQLite
package on the retained PVC. The running service needs no Caddy, Envoy or other
dynamic-route control plane. Provider adapters and selection semantics remain
reviewed source delivered through the normal image lifecycle.

The request and response transport boundary, including upstream identity
encoding and stale response-header handling, is defined in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#optional-pooled-ai-capacity). An
upstream body-read failure records only a fixed bounded failure class, an
`identity`/`encoded` bucket, and saturated chunk and byte counters when the
downstream request remains active. Downstream request aborts and response-stream
cancellations produce no failure observation. That observation never includes
prompts, request or response bodies, credentials, URLs, headers,
provider/routing/account/session identity, or full errors, messages or stacks.

The package, executable, Kubernetes resources, Service DNS, Secret, PVC path,
environment and client headers consistently use the `ai-gateway` identity.
The default First Mate, Second Mate, and Crewmate Kubernetes subtrees each own
one optional `patches/ai-gateway-client.yaml`. A reviewed per-Agent overlay
composes only the approved clients. Repeated Gateway-owned device logins create
the multi-subscription pool; `$agentos-ai-gateway` owns the exact lifecycle and
native Pi/Codex configuration.

## OpenTelemetry

The Gateway initializes fail-open OpenTelemetry only when the standard
`OTEL_*` workload environment selects a configured exporter. It emits bounded
request, authentication, route-acquisition, route-release, upstream, and stream
spans plus the contract-v1 metrics documented in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#ai-telemetry-contract-v1).
Readiness never depends on telemetry export.

Validated inbound `traceparent` and `tracestate` continue the runtime trace.
Every provider attempt receives a fresh `x-client-request-id`; inbound
`x-agentos-*` correlation metadata is consumed by the Gateway and stripped
before OpenAI. Provider request IDs appear only on protected spans and
correlated failure logs. Metrics never contain request, trace, span, operation,
attempt, session, route-slot, provider-account, or provider-request IDs.

Use the released `agentos-observability` Skill for the controlled
default-extension versus `-ne -e observability` matrix, portable dashboards,
alerts, and runbooks.
