# AgentOS agentgateway decision record

Status: **accept standalone agentgateway v1.4.1 as a selective policy-enforcement point, with the topology and gaps below**.

This is the evidence record for [AgentOS issue #93](https://github.com/akua-dev/agentos/issues/93). It does not install a controller, CRD, transparent proxy, service mesh, TLS interception, or default-deny Internet egress.

## Decision

AgentOS will use explicit gateway Services for governed provider, API, gRPC, and MCP traffic. Ordinary Internet traffic remains direct. Agent workloads do not receive reusable provider credentials; they present a short-lived, audience-bound Kubernetes workload identity token to the selected gateway endpoint.

The first topology is deliberately narrow:

```text
Mate or Crewmate
  projected ServiceAccount identity token
          |
          v
agentgateway-openai (PEP)
  holds no Fleet AI Gateway or provider credential
          |                         |
          | authorize               | closed grant only; no credentials
          +----------------------> agentos-egress-authz
          |                         TokenReview identity + OpenFGA PDP
          v
Fleet AI Gateway
  validates the <=15-second grant and removes workload identity
  owns Codex/OpenAI login, account selection, quota and session semantics
          |
          v
OpenAI

All unrelated Internet destinations: direct from the Agent Pod
```

Other credential domains use separate gateway instances or brokers. The GitHub App key belongs to the GitHub broker, provider OAuth belongs to the provider-specific credential component, and OpenAI/Codex credentials remain in the Fleet AI Gateway. No agentgateway process may mount every Fleet credential.

The selected placement is **alongside and immediately in front of explicit governed backends**, not in front of every Pod connection and not inside the Fleet AI Gateway. It preserves the existing provider controller while giving AgentOS one PEP interface for workload identity, OpenFGA decisions, profile budgets, credential injection and safe telemetry.

| Placement                                                            | Decision | Reason                                                                                               |
| -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| In front of all Agent Pod traffic                                    | Reject   | Makes ordinary Internet depend on the PEP and requires forward-proxy/TLS-interception semantics      |
| Inside Fleet AI Gateway                                              | Reject   | Couples general authorization and non-OpenAI providers to the Codex account/session/quota controller |
| Alongside AgentOS, immediately before each explicit governed backend | Select   | Keeps ordinary egress direct, preserves provider ownership, and scopes each gateway to one domain    |

## Why not `HTTP_PROXY` everywhere

A global `HTTP_PROXY` or `HTTPS_PROXY` would make normal Internet availability depend on agentgateway. HTTPS `CONNECT` also hides the request path and body from a forward proxy and prevents just-in-time credential injection unless AgentOS intercepts TLS. AgentOS rejects that topology.

Clients with a provider base-URL setting point it at an explicit AgentOS gateway Service. Tools that cannot select an API base URL need a reviewed adapter or broker. [#94](https://github.com/akua-dev/agentos/issues/94) now provides that boundary for native `git`, `gh`, and `gh-axi`: an owned host and Git rewrite target `agentgateway-github`, a per-call projected-token helper, fail-closed REST/Git/GraphQL classification, and a GitHub-only broker. Ordinary Internet traffic remains direct. No universal `HTTP_PROXY`, TLS interception, App-key mount, per-Agent GitHub token Secret, or token-returning API is used.

## PEP, PDP and credential boundaries

| Boundary               | Owns                                                                                                 | Must not own                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent workload         | projected identity token, selected access-profile ID                                                 | provider API keys, OAuth refresh tokens, shared AI Gateway token       |
| agentgateway PEP       | route enforcement, workload identity forwarding, closed-grant replacement, protocol fidelity        | policy source of truth, provider credentials, Agent judgment           |
| `agentos-egress-authz` | Kubernetes TokenReview adapter, request context normalization, OpenFGA check, stable denial envelope | provider credentials                                                   |
| OpenFGA                | authorization model, tuples and reusable profile relations                                           | credentials, request forwarding                                        |
| credential component   | one provider/domain secret or token exchange                                                         | authorization decision                                                 |
| Fleet AI Gateway       | Codex/OpenAI login and account/session/quota semantics                                               | non-OpenAI provider roots, general Fleet authorization                 |

Agentgateway's external authorization policy defaults to fail closed. The Effect-native [`agentos-egress-authz`](../egress-authz/README.md) adapter returns only finite, payload-free authorization outcomes and closed grant headers; it never logs the token or request body. Workload, policy and dependency failures use stable `401`, `403`, and `503` envelopes. AgentOS `rate_limited` and `budget_exhausted` use stable `429` envelopes plus `x-agentos-denial-reason`, so they remain distinguishable from an upstream provider's unmodified `429`. Provider, upstream and gateway failures retain their real HTTP/gRPC status. The durable counter and surgical kill-switch design is documented in [`provider-budget-enforcement.md`](../../docs/security/provider-budget-enforcement.md).

The provider-delivery contract is now released in [`docs/security/provider-credential-delivery.md`](../../docs/security/provider-credential-delivery.md). Its closed Effect Schemas and separate PEP/PDP/CDP services carry decision and Secret references but never credential values. Static and OAuth client Secrets are projected as one read-only file into one provider adapter. AWS/GCP use workload identity without a Secret. GitHub App and refresh-token cases select a provider-only broker; unsupported native clients fail closed instead of receiving a token.

Pinned v1.4.1 loads file-backed static and OAuth secrets while parsing configuration, so a projected Secret update is not described as a live credential reload. Rotation uses #80's resource-version-guarded replacement, then rolls only the affected two-replica adapter. The deterministic route-state contract permits a stale resource version for at most 60 seconds; at the deadline that provider route becomes `credential_unavailable`. Agent Pods and unrelated provider adapters are not restarted.

| Failure class                | Authoritative signal                                                    | Owner                                    |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| workload identity            | finite content-free `401/403`                                           | TokenReview adapter                      |
| authorization/profile        | finite content-free `403`                                               | OpenFGA adapter                          |
| budget/kill switch           | `429` plus `budget_denied`                                              | authorization adapter and budget service |
| policy dependency            | finite content-free `503`                                               | authorization adapter                    |
| credential delivery/exchange | `502/503` plus `credential_unavailable` or `credential_exchange_failed` | provider-scoped credential component     |
| agentgateway process/config  | readiness/config-synchronization signal and gateway-local `5xx`         | gateway operations                       |
| governed provider/upstream   | original upstream HTTP status or gRPC status                            | provider adapter/backend                 |

Agentgateway preserves the external authorization denial body and upstream status in the executable suite, but it does not manufacture this complete AgentOS vocabulary. The TokenReview/OpenFGA adapter and provider-scoped credential components own the stable envelopes; agentgateway owns forwarding them without replacing them with a generic success or retry.

## Pinned release

[`release.json`](./release.json) pins:

- standalone release `v1.4.1`, commit `163ea2146acb7b82082acea30ed691b29079095f`;
- the multi-architecture image index digest;
- the standalone Helm chart version, OCI manifest digest and downloaded archive SHA-256;
- Darwin arm64, Linux amd64 and Linux arm64 binary SHA-256 values.

The release is stable, not an alpha or nightly build. The executable test validates the binary version's configuration directly. See the [v1.4.1 release](https://github.com/agentgateway/agentgateway/releases/tag/v1.4.1) and [standalone release notes](https://agentgateway.dev/docs/standalone/latest/reference/release-notes/).

## Executable evidence

[`tests/conformance.test.ts`](./tests/conformance.test.ts) starts mock authorization, generic HTTP, HTTP/2 gRPC, OpenAI-compatible, OAuth token, MCP and OTLP endpoints, then runs the exact pinned binary. It proves:

| Capability                                 | Result                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Generic HTTP reverse proxy                 | Passed; real path/status preserved                                                                  |
| Latency                                    | Passed; emits direct/governed p50 and p95 plus proxy delta from 20 warmed requests                  |
| Workload identity decision                 | Passed; missing identity denied before the backend                                                  |
| Workload identity-to-grant mediation       | Passed; forged decision headers were replaced by the authorizer's bounded grant at the AI Gateway boundary |
| External authorization failure mode        | Passed fail closed; denial body remained distinguishable                                            |
| RFC 8693-style OAuth token exchange        | Passed; subject token exchanged and downstream bearer injected                                      |
| OpenAI `/v1/responses`                     | Passed through the native LLM route                                                                 |
| OpenAI `/v1/responses/compact`             | Passed opaque compaction artifact byte-semantically through the Fleet AI Gateway route              |
| Streaming                                  | Passed without buffering the complete response                                                      |
| Backpressure and cancellation              | Passed; upstream stream was not exhausted and observed downstream cancellation                      |
| Provider rate limit                        | Passed; upstream 429 remained 429                                                                   |
| Retry                                      | Passed exactly two attempts on one explicitly matched 503-safe route; no global provider retry      |
| HTTP/2 gRPC                                | Passed with frame fidelity and backend-token replacement                                            |
| MCP                                        | Passed modern `2026-07-28` tool discovery through streamable HTTP                                   |
| A2A v1 live delivery                       | Passed authenticated card rewrite and reference-only `SendMessage`; PostgreSQL remains authoritative |
| Prometheus metrics                         | Passed on `/metrics`                                                                                |
| OTLP/HTTP tracing                          | Passed; protected payload and all test credentials absent from exported bytes                       |
| Static validation                          | Passed with `--validate-only`                                                                       |
| Valid hot reload                           | Passed                                                                                              |
| Invalid reload                             | Passed repair-forward: last good routes remained live and `config_synchronized` changed to `0`      |
| Reload repair/rollback                     | Passed after restoring the last known-good file; `config_synchronized` returned to `1`              |
| Readiness                                  | Process readiness passed, but remained `200` after a rejected reload; see the operational gap below |

The retry result is intentionally narrow. OpenAI Responses and tool calls are not assumed idempotent and must not receive blanket retries. A profile can enable retry only where its operation contract and idempotency key make duplication safe. Agentgateway's documented route timeout ends at response headers, so stream-lifetime budgets and cancellation remain separate AgentOS policies. See the [timeout documentation](https://agentgateway.dev/docs/standalone/latest/configuration/resiliency/timeouts/).

The OpenAI route uses HTTP external authorization. Agentgateway derives the
original method and path inside its own configuration, forwards the projected
bearer token and optional Assignment hint only to the authorizer, then
overwrites every `x-agentos-grant-*` header from the authorization response.
The AI Gateway independently verifies the signed grant and strips both the
workload credential and all AgentOS decision headers before provider dispatch.

The latency sample is informational rather than an environment-independent SLO. It measures the same local mock backend directly and through agentgateway with external authorization, alternates the paths after warm-up, and prints only numeric p50/p95 milliseconds and the median delta. Production latency SLOs belong to [#92](https://github.com/akua-dev/agentos/issues/92) on the actual cluster/network/provider path.

## Reproduce

Download the binary and chart from the pinned release, verify the binary against [`release.json`](./release.json), then run:

```bash
AGENTOS_AGENTGATEWAY_BIN=/absolute/path/to/agentgateway-darwin-arm64 \
AGENTOS_AGENTGATEWAY_CHART=/absolute/path/to/agentgateway-standalone-1.4.1.tgz \
bun run --cwd services/agentgateway conformance

AGENTOS_AGENTGATEWAY_BIN=/absolute/path/to/agentgateway-darwin-arm64 \
bun run --cwd services/agentgateway a2a:conformance

bun run --cwd services/agentgateway test
```

The executable conformance is explicitly skipped by the ordinary offline test suite unless both paths are set. It never downloads a mutable `latest` artifact.

The A2A spike uses only the binary path, verifies its platform checksum,
version, and Git revision, and can optionally write its bounded numeric latency
sample to `AGENTOS_A2A_METRICS_PATH`. The full PostgreSQL-first decision,
version gap, authority boundaries, and implementation gate are recorded in
[`a2a-postgresql-first-evaluation.md`](../../docs/research/a2a-postgresql-first-evaluation.md).

## Helm versus Kustomize

AgentOS keeps Kustomize as the deployment source of truth. [`kubernetes/values.yaml`](./kubernetes/values.yaml) is a reviewed, reproducible upstream-chart render input, not a direct production install instruction.

The pinned chart's read-only mode, ConfigMap checksum, security context, probes, ClusterIP override, resource settings and immutable image override are useful. The exact render also proves that the chart does **not** set `automountServiceAccountToken: false`, create an AgentOS NetworkPolicy or PodDisruptionBudget, express Fleet topology spreading, or expose AgentOS' semantic readiness condition. Its optional monitoring mode emits a `PodMonitor`, while AgentOS uses its existing OpenTelemetry collector and must not acquire a Prometheus Operator dependency just for this service.

The production implementation in [#96](https://github.com/akua-dev/agentos/issues/96) therefore owns reviewed Kustomize manifests and compares every upgrade against this pinned chart. Upgrade means: pin the new release/digests, rerun the semantic suite, render and diff the new chart, update owned manifests, canary one credential domain, then roll forward. Rollback means reapply the prior immutable Kustomize revision and last-known-good config. No database migration is involved because AgentOS omits agentgateway's request-log database.

## Operations and observability gaps

- `/healthz/ready` reports process/config startup readiness, but a rejected hot reload keeps the last good config and leaves readiness healthy. Kubernetes readiness must combine `/healthz/ready` with `agentgateway_config_synchronized == 1`, implemented in [#96](https://github.com/akua-dev/agentos/issues/96).
- The admin UI remains loopback-only and is not an Agent or operator mutation surface. Production policy changes flow through reviewed configuration/OpenFGA state.
- AgentOS omits `config.database`. This avoids a request database and its full span-attribute blob; cost dashboards that require it are deliberately unavailable. The official docs confirm that request logging is disabled when the database field is omitted: [request-log storage](https://agentgateway.dev/docs/standalone/latest/integrations/observability/database/).
- Native OTLP and Prometheus support are accepted, but the Fleet collector must continue removing content-bearing attributes. See the official [tracing](https://agentgateway.dev/docs/standalone/latest/reference/observability/traces/) and [metrics](https://agentgateway.dev/docs/reference/observability/metrics/) documentation.
- Dynamic route reload is accepted. Static listener/admin/process configuration still requires a rollout. The pinned source keeps the previous state after a failed reload and publishes the synchronization metric: [state manager at v1.4.1](https://github.com/agentgateway/agentgateway/blob/163ea2146acb7b82082acea30ed691b29079095f/crates/agentgateway/src/state_manager.rs).

## Shipped features versus architectural material

The [credential-injection article](https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/) supports proxy-mode credential isolation and explicitly warns that a central token store becomes a critical target. AgentOS adopts the PEP/PDP split but rejects a single all-credentials store; the article is architectural guidance, not proof that an unscoped production vault is safe.

The [context-compression article](https://agentgateway.dev/blog/2026-07-27-optimize-token-cost-with-context-compression/) does not replace AgentOS compaction by itself. This spike proves that opaque `/v1/responses/compact` artifacts survive the selected generic route. [#106](https://github.com/akua-dev/agentos/issues/106) must separately prove server-owned compaction selection, persistence, replay and fallback against the actual OpenAI/Fleet AI Gateway path before the current Pi extension can retire.

The [kill-switch and memory article](https://agentgateway.dev/blog/2026-02-21-kill-switch/) is a useful deployment example, not a released universal memory or kill-switch subsystem. AgentOS maps gateway budgets/revocation to [#107](https://github.com/akua-dev/agentos/issues/107) and evaluates hybrid/vector memory independently under the memory epic; memory truth does not move into agentgateway.

MCP `2026-07-28`, task cancellation, unified gateways and standalone Helm packaging are shipped in v1.4.1. The protocol version was upcoming when announced, so AgentOS keeps `2025-06-18` compatibility until client conformance in [#109](https://github.com/akua-dev/agentos/issues/109) proves the Fleet can advance.

## Dependent implementation order

1. [#88](https://github.com/akua-dev/agentos/issues/88): capability registry and ceilings.
2. [#87](https://github.com/akua-dev/agentos/issues/87): audience-bound projected identity and TokenReview adapter.
3. [#90](https://github.com/akua-dev/agentos/issues/90): OpenFGA PDP and hot-reloadable authorization data.
4. [#89](https://github.com/akua-dev/agentos/issues/89): reusable provider/API access profiles selected by typed workloads.
5. [#95](https://github.com/akua-dev/agentos/issues/95): released split credential delivery, one-domain Secret mounting, and bounded rotation state.
6. [#91](https://github.com/akua-dev/agentos/issues/91): replace Agent-facing Fleet AI Gateway shared auth with workload identity mediation.
7. [#94](https://github.com/akua-dev/agentos/issues/94): GitHub API broker and exact `gh` compatibility.
8. [#96](https://github.com/akua-dev/agentos/issues/96): owned Kustomize operations, readiness, canary upgrade and rollback.
9. [#92](https://github.com/akua-dev/agentos/issues/92): Kubernetes and failure-matrix conformance.
10. [#81](https://github.com/akua-dev/agentos/issues/81), [#106](https://github.com/akua-dev/agentos/issues/106), [#107](https://github.com/akua-dev/agentos/issues/107), and [#109](https://github.com/akua-dev/agentos/issues/109): revocation, compaction, budgets/kill switches and MCP expansion.
