# Resilient Delegation, Provider Access, and Effect Design

**Date:** 2026-07-31

**Status:** Approved for issue decomposition; implementation requires follow-up plans

**Parent program:** [#85 — make AgentOS Fleet operations resilient by construction](https://github.com/akua-dev/agentos/issues/85)

## Purpose

AgentOS must let a First Mate delegate broad domains to Second Mates, let each Second Mate create and supervise Crewmates without cross-domain RBAC failures, and keep the Fleet recoverable when identities, credentials, providers, Pods, sessions, storage, or streams fail.

The approved design adds four connected programs to the existing resilience epic:

1. workload-identity provider access with reusable, dynamically managed authorization profiles; and
2. an incremental migration of AgentOS-owned effectful TypeScript to Effect;
3. eval-gated hybrid retrieval for private per-Mate memory; and
4. privacy-preserving operational observability across delegation, memory,
   provider access, cost, and recovery.

The existing namespace, readiness, credential-safety, operation-journal, supervision, observability, and failure-conformance work remains part of the program.

## Evidence and constraints

The live First Mate session and cluster inspection exposed concrete failure modes:

- a Second Mate could supervise named existing Pods but could not safely create future Crewmate Pods under Kubernetes RBAC;
- provider bootstrap on a fresh Pi PVC could select an unknown provider;
- credential refresh and Secret projection depended on manual and unsafe paths;
- capacity, PVC topology, listener state, native-session state, and retry exhaustion were not represented as durable, actionable readiness or recovery states; and
- ordinary transport and stream failures were collapsed into generic failure signals.

The design keeps the repository's native-tools-first boundaries: Kubernetes owns runtime truth, PostgreSQL owns custody and workflow truth, native sessions own execution truth, PVCs own unfinished work, and Git owns delivered code. It does not introduce an AgentOS Kubernetes operator or a shadow runtime database.

## Decisions

### Delegation topology

Each persistent Second Mate receives a First-Mate-managed namespace. The Second Mate and its Crewmates run in that namespace, and its ServiceAccount can create and manage only the approved child workload kinds there.

The First Mate owns the namespace boundary and the controls inside it:

- Namespace lifecycle and ownership metadata;
- Roles and RoleBindings;
- ResourceQuota and LimitRange;
- approved workload shapes and admission policy;
- NetworkPolicy needed for namespace isolation; and
- provider-access profile ceilings.

The Second Mate may freely expand, modify, and shrink its Crewmate pool inside those controls. It cannot modify its own RBAC, quota, admission rules, namespace boundaries, or provider-access ceiling. Because any Secret in that namespace can be reached through a Pod the Second Mate creates, Fleet-root and provider-root credentials must never be placed there.

### First Mate delegation responsibility

The First Mate is the maintainer of Second-Mate topology, not a dispatcher for every individual task. It continuously evaluates whether broad domains need to be created, merged, split, expanded, contracted, or retired.

Decisions use explicit signals rather than organizational habit:

- queued and active Assignment load;
- dependency crossings between domains;
- retry, failure, and escalation rates;
- context switching and coordination overhead;
- capacity and quota pressure;
- sustained idle time; and
- delivery quality and latency.

A Second Mate owns a coherent broad domain and can form temporary Crewmate teams. It must not become a permanent silo: shared contracts remain Fleet-level, cross-domain dependencies remain visible, and the First Mate periodically reevaluates boundaries. Topology changes are journaled and repair-forward so a partial Kubernetes or SQL failure can be reconciled without duplicate Mates or lost Assignments.

### Credentialed provider access

AgentOS will use an explicit provider-access plane. It is not a transparent proxy for all Internet traffic.

```text
Mate Pod
  | projected short-lived ServiceAccount JWT (dedicated audience)
  v
agentgateway policy-enforcement route
  | ext-auth request
  v
AgentOS Effect authorizer
  | TokenReview + ServiceAccount UID + Pod/Mate/Assignment resolution
  | OpenFGA capability check
  v
provider-scoped credential-delivery adapter
  | provider-specific Secret mounted only here
  v
upstream API
```

Normal outbound Internet remains available to Agents. AgentOS will not set a universal `HTTP_PROXY`, perform TLS interception, or add blanket/default-deny Internet egress as part of this program. Only approved credentialed provider routes use the access plane. A direct-provider path remains an explicit small-Fleet or break-glass deployment option.

Agentgateway standalone is the recommended data plane because it supports generic HTTP/gRPC routes, CEL and external authorization, multiple backend credential mechanisms, OAuth token exchange, and dynamic configuration. The initial integration pins a tested release and does not install its Kubernetes controller or CRDs.

The access plane separates three responsibilities:

- agentgateway is the policy-enforcement point and never decides AgentOS
  hierarchy or Assignment semantics;
- the Effect authorizer plus OpenFGA is the policy-decision point and never
  receives an upstream credential; and
- each provider-scoped adapter is a credential-delivery point that injects
  only that provider's credential after an allow decision.

One gateway process must not become a vault containing a universal token or
every provider's root credential. Providers that implement compatible OAuth
token exchange may use agentgateway backend authentication directly. Providers
such as GitHub that cannot exchange the projected Kubernetes identity use a
narrow provider adapter. Compromise of one delivery adapter must not expose an
unrelated provider credential.

The existing AI Gateway remains responsible for AI-specific pooled quota, provider, and OAuth semantics during the migration. The first spike must prove whether agentgateway belongs in front of it, alongside it, or only in the generic provider path. It must not silently replace working AI Gateway behavior.

Native GitHub tools are a special case. `git`, `gh`, and `gh-axi` use an
internal GitHub-compatible endpoint plus a credential helper that reads the
current projected ServiceAccount token. The endpoint validates that workload
identity, authorizes the repository and operation, strips the AgentOS token,
and injects a GitHub App installation token upstream. Provider tokens never
return to the Mate. A generic HTTPS proxy cannot inspect methods and paths or
inject authorization through CONNECT without TLS interception; `HTTP_PROXY`
and `HTTPS_PROXY` therefore are not the GitHub credential solution.

### Native OpenAI compaction

AgentOS keeps its Pi session-lifecycle compaction extension. The extension
already invokes OpenAI's native `/v1/responses/compact` or Codex compaction
transport, validates the terminal response and opaque `encrypted_content`
artifact, persists compatible replay state, and retains a portable Pi summary
as fallback. Agentgateway routes and authenticates both `/responses` and
`/responses/compact`; it does not take ownership of compaction triggering,
persistence, model/provider compatibility, replay, or fallback.

Agentgateway's announced `contextCompression` extension is a generic,
request-local `/v1/compress` hook. Its message-rewrite contract does not return
OpenAI's opaque compaction artifact to Pi for later session replay, and the
feature was described as upcoming when this design was approved. It is not a
replacement for the AgentOS extension. A later spike may benchmark it for
stateless or non-Pi routes only. Adoption requires better end-to-end task
success and total-session cost, not merely fewer tokens in one request.

### Additional agentgateway capabilities

The first access-plane release also evaluates:

- per-Mate, per-Assignment, and per-profile request, token, and spend budgets;
- surgical revocation and rate-class-zero kill switches that do not interrupt
  unrelated Mates or ordinary Internet access;
- MCP federation with profile-scoped tool catalogs and authorization on the
  MCP tool plus bounded resource arguments; and
- token and cost telemetry exported through the Fleet OpenTelemetry pipeline.

Model routing remains pinned for a persistent session or Assignment. Silent
per-turn semantic routing or cross-model failover can invalidate native
compaction replay, prompt caching, and behavior expectations. It may be piloted
later for disposable stateless Crewmates with task-success evals. Stateful
behavioral guardrails may later consume the operation journal as
defense-in-depth, but they do not replace OpenFGA capability checks.

### Workload identity

Every routed request presents a short-lived projected Kubernetes ServiceAccount token with an AgentOS-specific audience. The Effect authorizer calls Kubernetes TokenReview and requires:

- successful authentication;
- the exact expected audience;
- unexpired token and active bound object;
- namespace, ServiceAccount name, and ServiceAccount UID match;
- a live Pod belonging to the resolved Mate; and
- an active Assignment when the capability is Assignment-scoped.

The authorizer maps runtime identity to the canonical AgentOS identity and authorization model. Agentgateway is not expected to understand AgentOS Mate or Assignment semantics.

Revocation must be deterministic. Deleting or replacing the bound identity, ending an Assignment, removing a profile binding, or shrinking a ceiling invalidates access. Positive caches are short, keyed by immutable identity, and bypassed or refreshed with higher consistency after an authorization mutation.

### Authorization and reusable profiles

OpenFGA is the recommended policy decision point. Its immutable authorization models, relationship tuples, conditions, role modeling, and PostgreSQL support fit reusable profiles and per-Mate bindings without giving the First Mate unrestricted policy-administration credentials.

The Captain/platform owns an immutable, finite vocabulary of canonical capabilities and the maximum envelope available to each Fleet or Second-Mate domain. Examples include:

- `github.repository.read`;
- `github.pull_request.write`;
- `github.issue.write`;
- `openai.responses.create`; and
- `provider.secret.use` for one named adapter.

Profiles are reusable named bundles over that vocabulary, such as `github-maintainer`. Dynamic tuples bind profiles to a Mate or Assignment and may include provider resource, expiry, environment, and rate-class constraints.

The First Mate uses a narrow AgentOS authorization-control API to:

- create a profile from capabilities inside its Captain-approved ceiling;
- revise a profile by publishing a new version;
- bind or revoke a profile for a Second Mate, Crewmate, or Assignment; and
- inspect effective access and audit history.

The First Mate never receives the OpenFGA administrator credential, the agentgateway administrator credential, or upstream provider credentials. The control API validates every mutation against the immutable ceiling, writes versioned tuples, emits an audit event, and performs a higher-consistency verification before acknowledging the change. A ceiling reduction takes precedence over all profile versions and bindings.

OpenFGA stores authorization relationships, not Kubernetes runtime state, provider secrets, prompts, or response bodies. Audit records contain acting workload identity, canonical Mate and Assignment IDs, profile/capability, provider resource, decision, reason category, policy version, correlation ID, and timing—never tokens or payloads by default.

### Secrets

This program does not add OpenBao or Vault. Kubernetes Secrets remain the delivery primitive and are hardened by the existing resilience work:

- no credential-bearing client-side apply annotations;
- restrictive projection modes;
- encryption at rest and narrow RBAC at the cluster level;
- provider-specific credentials mounted only into the gateway or adapter that needs them; and
- short-lived provider credentials where the upstream supports them.

There is no single master token that grants every provider capability. Centralized policy evaluation does not imply centralized root credentials.

### Deployment packaging

AgentOS keeps Kustomize for first-party Fleet manifests and overlays. A repository-wide migration to Helm would add templating and release-state complexity without fixing the observed RBAC, readiness, identity, or recovery failures.

Helm may be used as an upstream packaging mechanism for third-party dependencies when that is their supported installation path. AgentOS pins and tests those dependencies, then integrates their stable Services, configuration, identities, and policy through its existing Kustomize overlays. If the agentgateway and OpenFGA spike finds that rendered upstream charts are less reproducible than owned manifests, AgentOS will vendor or generate reviewed manifests instead. This is a hybrid packaging decision, not a Helm rewrite.

## Private Mate memory retrieval

The existing memory authority remains the typed Markdown topic set and concise
`MEMORY.md` index on each persistent Mate's PVC. Memory remains private,
fallible context and never proves identity, authority, approval, current state,
or permission. Automatic extraction, Dream consolidation, pause, correction,
forgetting, routed proposals, attachment limits, and the current LLM relevance
selector remain valid behavior.

The current selector sees the redacted human request, index, and bounded topic
inventory, then spends a model call selecting up to five topic paths. This is a
sound fallback but can miss a useful topic when its index hook or metadata is
weak, and it adds provider latency and cost to recall. AgentOS will evaluate a
rebuildable per-Mate hybrid retrieval cache:

1. establish a fixed privacy-safe corpus and measure the current selector;
2. add local lexical/BM25 retrieval over bounded topic chunks;
3. evaluate optional local embeddings and vector similarity;
4. combine lexical, semantic, metadata, and bounded recency signals with a
   deterministic, versioned ranker; and
5. retain the current selector as a fallback or measured reranker until the
   replacement proves better.

Markdown remains the only memory truth. Any lexical or vector index is a
derivative cache on the owning Mate's PVC, carries source hashes and schema,
chunker, model, and ranker versions, and can be deleted and rebuilt. It is not
stored in PostgreSQL, shared across Mates, or treated as proof that a memory is
current. A corrupt, stale, unavailable, or resource-constrained index degrades
to the existing bounded recall path without blocking the main turn.

Real memory content does not leave the Mate Pod for embedding by default. The
initial vector evaluation uses a local model and synthetic or explicitly
approved evaluation data. A remote embedding provider would be a separate,
explicit provider-access capability and privacy decision, not an implicit
consequence of enabling memory. Pause and forget must prevent recall
immediately and remove or invalidate corresponding derivative chunks before
the operation is acknowledged.

The evaluation gate measures recall and precision at the configured attachment
budget, downstream task success, added latency, provider calls, prompt and
embedding cost, CPU and memory pressure, index size, rebuild time, corruption
recovery, and forgetting correctness. AgentOS does not add mandatory semantic
indexing unless the hybrid path materially beats the present selector without
weakening privacy or recovery.

## Full operational observability

AgentOS extends its existing content-free OpenTelemetry contract and
Fleet-local Collector rather than adopting agentgateway's request-log database
as another authority. Full observability means that an operator can follow an
operation across Mate, Assignment, memory lifecycle, authorizer, TokenReview,
OpenFGA decision, agentgateway, credential adapter, MCP or HTTP operation, and
provider outcome. It does not mean recording the Agent's private content.

The versioned telemetry contract covers:

- trace propagation and safe correlation across Fleet, Mate, Assignment, Pod,
  native session, access profile version, route, and provider operation;
- authorization allows and denials, revocation latency, policy version,
  readiness, and dependency failures;
- requests, tokens, cached tokens, cost, rate-limit state, budget consumption,
  streaming, cancellation, retries, and provider outcomes;
- memory extraction, Dream, selector/index method, candidate and attachment
  counts, bounded bytes/tokens, latency, degradation reason, index freshness,
  rebuilds, and forget invalidation; and
- topology decisions, operation-journal recovery, retry exhaustion, and the
  semantic readiness signals needed by dashboards, alerts, and runbooks.

Dynamic identifiers and provider resources appear only in protected spans,
correlated logs, or audit events. Metrics use bounded dimensions and never use
Mate, Assignment, session, trace, request, profile name, repository, or
provider-resource identifiers as labels. The instrumentation and Collector
both reject prompts, system prompts, transcripts, memory bodies, request or
response bodies, tool arguments or results, authorization headers, tokens,
cookies, credentials, provider identities, and arbitrary exception bodies.

Agentgateway exports native traces and metrics to the same Collector with the
canonical workload identity added from validated claims. AgentOS uses the
gateway's model-cost catalog where useful but exports the resulting bounded
token and cost measures through OpenTelemetry. Agentgateway SQLite request
logs, prompt logging, and content-bearing analytics remain disabled or outside
the supported production posture. Telemetry stays asynchronous and fail-open;
authorization and budget enforcement remain fail-closed independently of
telemetry availability.

## Effect migration

### Target boundary

Every AgentOS-owned fallible, asynchronous, concurrent, resource-managed, or I/O TypeScript path will use Effect. Pure calculations and presentational React/TSX stay pure; they are not wrapped in Effect merely to satisfy a count. Runtime escape from Effect is allowed only at unavoidable program, HTTP framework, browser, extension, or tool boundaries.

The repository pins one exact compatible Effect beta family across workspaces. New code follows the existing Effect skill and repository standards:

- `Context.Tag` services composed with explicit `Layer`s;
- `Schema` for repository-owned contracts, parsing, and serialization;
- tagged, typed domain errors instead of thrown or stringly typed failures;
- `Config` for environment and secret references;
- scoped resource lifecycles, structured concurrency, `Schedule`, `Stream`, and queues where appropriate;
- `@effect/platform-bun` for Bun HTTP/process/filesystem boundaries;
- Effect SQL PostgreSQL services for runtime database access while raw SQL migrations remain authoritative;
- `@effect/vitest` for service and failure-path tests; and
- OpenTelemetry spans and metrics at service boundaries.

### Migration sequence

The migration is incremental and behavior-preserving, never a flag day:

1. establish architecture rules, exact dependency alignment, CI checks, and boundary adapters;
2. migrate shared contracts, configuration, errors, logging, tracing, and core service layers;
3. migrate the AI Gateway and build the provider-access authorizer as Effect-native services;
4. migrate AgentOS runtime composition, lifecycle, supervision, and reconciliation;
5. migrate Pi extensions, memory, compaction, and native-session integration;
6. migrate database tooling, CLIs, and release programs;
7. migrate website server, data, worker, and API paths while leaving pure UI functions pure;
8. convert tests and add cross-implementation behavior/conformance gates; and
9. remove temporary Promise/schema/error adapters and enforce the final boundaries.

Each slice starts with characterization tests, keeps a narrow adapter around not-yet-migrated code, and removes that adapter when the downstream slice lands. No issue may combine migration with unrelated product behavior unless the behavior is needed to preserve semantics.

## Failure behavior

The access plane fails closed for credentialed provider routes but does not take down ordinary Internet access.

- invalid identity, inactive Assignment, or denied capability returns a typed authorization error;
- unavailable TokenReview or OpenFGA does not fall back to a provider credential;
- expired or rejected provider credentials trigger only the provider-specific refresh/recovery path;
- gateway or authorizer unavailability is surfaced distinctly from upstream transport, rate-limit, and provider failures;
- policy and profile changes are versioned and auditable;
- retries are bounded and preserve idempotency; and
- logs, traces, and journals exclude tokens and request/response bodies by default.

Memory retrieval fails open to the current bounded selector or index-only
startup context. A missing, stale, corrupt, or incompatible derivative index
never hides the authoritative Markdown topic set, blocks the main turn, or
prevents an explicit correction or forget operation. Telemetry failure may
drop diagnostic signals but cannot allow a denied provider operation, consume
the gateway credential volume, or change workload readiness.

The gateway, authorizer, and OpenFGA require readiness checks that prove useful semantics, not merely open ports. Their disruption and recovery paths join the existing disposable-Fleet failure-conformance matrix.

## Acceptance criteria

### Delegation

- A Second Mate creates, changes, and deletes approved Crewmate workloads in its own namespace without a per-Crewmate First Mate apply.
- It cannot cross namespaces, elevate RBAC, alter quotas/policy, or access Fleet-root credentials.
- First Mate topology decisions are explainable, bounded, journaled, and recoverable after partial failure.
- Domain boundaries can expand, shrink, split, merge, and retire without losing Assignment custody or creating permanent silos.

### Provider access

- Two Pods with different ServiceAccounts receive different decisions for the same route and no workload can impersonate another Mate.
- Reusable profiles can be created and rebound by the First Mate only inside Captain ceilings.
- Assignment end, identity deletion, binding revocation, and ceiling reduction deny subsequent credentialed calls within a defined revocation SLO.
- Upstream credentials never appear in Agent namespaces, responses, logs, traces, journals, or persisted gateway configuration.
- Native AI and GitHub clients retain their meaningful provider errors and Assignment attribution.
- Native OpenAI compaction remains replay-compatible across restarts and is not
  replaced by request-local gateway compression.
- Each provider credential is isolated to its delivery adapter; compromising
  one adapter does not grant another provider's capability.
- Per-Mate and per-Assignment kill switches and budgets deny only the intended
  identity/profile and leave unrelated Mates and ordinary Internet working.
- Ordinary Internet access continues when the credentialed access plane is unavailable.

### Memory

- A reproducible evaluation compares the current LLM selector, local lexical
  retrieval, and optional local hybrid retrieval on identical bounded inputs.
- The selected path improves retrieval quality or downstream task success
  without regressing latency, cost, privacy, or Pod resource limits beyond its
  declared budget.
- Markdown topics remain authoritative and every derivative index can be
  deleted and rebuilt from source files plus versioned configuration.
- Pause and forget prevent stale lexical or vector hits immediately, including
  after interruption or index corruption.
- Cross-Mate memory retrieval and unapproved remote embedding are impossible.

### Observability

- One trace can correlate a Mate/Assignment operation with memory work,
  authorization, gateway, adapter, MCP or HTTP operation, and provider outcome
  without recording content.
- Operators can distinguish identity, policy, credential, budget, rate-limit,
  gateway, provider, stream, memory-index, compaction, and telemetry-pipeline
  failures.
- Token and cost measures are attributable through protected traces and
  bounded aggregate metrics without turning dynamic IDs into metric labels.
- Dashboards, alerts, and runbooks cover access denials, revocation SLO,
  budget exhaustion, provider health, memory degradation, topology recovery,
  and Collector/exporter health.
- Automated privacy, cardinality, trace-continuity, restart, queue-exhaustion,
  and content-rejection tests gate the supported deployment.

### Effect

- Each migration slice has characterization, service, and failure tests before the legacy path is removed.
- Repository-owned boundary data is decoded with Effect Schema and failures remain typed end to end.
- Long-running services use scoped resources and structured concurrency; interruption releases listeners, processes, database connections, and streams.
- CI rejects newly introduced unapproved effectful Promise/throw/schema patterns after the relevant directory is migrated.
- Final enforcement finds no AgentOS-owned effectful TypeScript outside approved runtime adapters.

## Alternatives considered

### Authorization engines

- **OpenFGA — recommended:** relationship-oriented reusable roles, conditional relationships, immutable models, PostgreSQL support, and a clean separation between a narrow AgentOS mutation API and the decision engine.
- **Cerbos:** strong resource policies, derived roles, scoped policies, and a dynamic Admin API. It is a credible fallback if policy documents prove clearer than relationship tuples, but its current mutable-store choices do not align as cleanly with AgentOS PostgreSQL operations.
- **OPA:** highly flexible and proven, including Envoy integration, but bundles and control-plane lifecycle would become AgentOS-owned work. Use only if authorization semantics outgrow the canonical capability/profile model.
- **Authorino:** Kubernetes TokenReview support is close to the identity requirement, but its operator, CRDs, and Envoy-oriented topology conflict with the initial no-controller constraint.

### Proxy approaches

- A custom universal proxy was rejected: routing, protocol correctness, TLS, streaming, retries, observability, and credential semantics are too large a new platform surface.
- Transparent `HTTP_PROXY` enforcement was rejected: HTTPS credential injection implies TLS interception and would block or distort normal Internet use.
- Provider-specific brokers alone remain useful for native clients, especially GitHub, but would duplicate common authentication, authorization, audit, and routing mechanics if used for every HTTP API.

### Memory retrieval approaches

- **Eval-gated local hybrid cache — recommended:** keep private Markdown as
  truth, add rebuildable lexical retrieval first, and enable local vector
  similarity only when it wins the quality/resource evaluation. This preserves
  the current selector as a safe migration and failure path.
- **Keep only the LLM selector:** operationally simple and already private, but
  adds a model request to recall and depends heavily on the quality of the
  concise index hook and topic metadata.
- **Replace memory with a shared vector service:** rejected because it creates
  a new cross-Mate content authority and availability/privacy boundary. A
  remote embedding service is not implied by the provider access plane.

## Source references

- [Agentgateway standalone overview](https://agentgateway.dev/docs/standalone/main/)
- [Agentgateway generic routes](https://agentgateway.dev/docs/standalone/main/configuration/routes/)
- [Agentgateway HTTP authorization](https://agentgateway.dev/docs/standalone/latest/configuration/security/http-authz/)
- [Agentgateway external authorization](https://agentgateway.dev/docs/standalone/latest/configuration/security/external-authz/)
- [Agentgateway backend authentication](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/)
- [Agentgateway OAuth token exchange](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/oauth-token-exchange/)
- [Agentgateway dynamic configuration](https://agentgateway.dev/docs/standalone/latest/configuration/static-configuration/)
- [Agentgateway credential injection and credential-broker analysis](https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/)
- [Agentgateway context-compression extension](https://agentgateway.dev/blog/2026-07-27-optimize-token-cost-with-context-compression/)
- [Agentgateway multi-agent kill switches, memory, budgets, and observability](https://agentgateway.dev/blog/2026-02-21-kill-switch/)
- [Agentgateway tracing](https://agentgateway.dev/docs/standalone/latest/reference/observability/traces/)
- [Agentgateway metrics](https://agentgateway.dev/docs/standalone/latest/reference/observability/metrics/)
- [Agentgateway cost and token analytics](https://agentgateway.dev/blog/2026-06-24-agentgateway-cost-tokenomics-dashboard/)
- [OpenAI native Responses compaction](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#compaction)
- [OpenClaw built-in hybrid memory engine](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-builtin.md)
- [OpenFGA roles and permissions](https://openfga.dev/docs/modeling/roles-and-permissions)
- [OpenFGA custom roles](https://openfga.dev/docs/modeling/custom-roles)
- [OpenFGA conditions](https://openfga.dev/docs/modeling/conditions)
- [OpenFGA immutable models](https://openfga.dev/docs/getting-started/immutable-models)
- [OpenFGA configuration and PostgreSQL](https://openfga.dev/docs/getting-started/setup-openfga/configure-openfga)
- [OpenFGA consistency](https://openfga.dev/docs/interacting/consistency)
- [Kubernetes ServiceAccount and TokenReview guidance](https://kubernetes.io/docs/concepts/security/service-accounts/)
- [Cerbos policies](https://docs.cerbos.dev/cerbos/latest/policies/index.html)
- [OPA management and bundles](https://www.openpolicyagent.org/docs/management-introduction)
- [Authorino Kubernetes TokenReview](https://docs.kuadrant.io/1.0.x/authorino/docs/user-guides/kubernetes-tokenreview/)

## Issue decomposition

The resilience epic remains the top-level program. Existing issue #27 is the
nested provider-access epic, #56 is broadened from AI-only telemetry into the
privacy-preserving operational-observability epic, #86 tracks the Effect
migration, and #108 owns private-memory retrieval evaluation and any later
lexical/vector implementation. Each owns
independently releasable subissues with explicit acceptance criteria; the
parent resilience epic owns cross-cutting ordering and conformance.

Implementation plans must be written per subissue after this design is reviewed. The agentgateway spike is a decision gate: production rollout and controller adoption are not implied by selecting it for evaluation.
