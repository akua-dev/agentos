# Resilient Delegation, Provider Access, and Effect Design

**Date:** 2026-07-31

**Status:** Approved for issue decomposition; implementation requires follow-up plans

**Parent program:** [#85 — make AgentOS Fleet operations resilient by construction](https://github.com/akua-dev/agentos/issues/85)

## Purpose

AgentOS must let a First Mate delegate broad domains to Second Mates, let each Second Mate create and supervise Crewmates without cross-domain RBAC failures, and keep the Fleet recoverable when identities, credentials, providers, Pods, sessions, storage, or streams fail.

The approved design adds two connected programs to the existing resilience epic:

1. workload-identity provider access with reusable, dynamically managed authorization profiles; and
2. an incremental migration of AgentOS-owned effectful TypeScript to Effect.

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
agentgateway explicit provider route
  | ext-auth request
  v
AgentOS Effect authorizer
  | TokenReview + ServiceAccount UID + Pod/Mate/Assignment resolution
  | OpenFGA capability check
  v
provider adapter / backend credential policy
  | provider-specific Secret mounted only here
  v
upstream API
```

Normal outbound Internet remains available to Agents. AgentOS will not set a universal `HTTP_PROXY`, perform TLS interception, or add blanket/default-deny Internet egress as part of this program. Only approved credentialed provider routes use the access plane. A direct-provider path remains an explicit small-Fleet or break-glass deployment option.

Agentgateway standalone is the recommended data plane because it supports generic HTTP/gRPC routes, CEL and external authorization, multiple backend credential mechanisms, OAuth token exchange, and dynamic configuration. The initial integration pins a tested release and does not install its Kubernetes controller or CRDs.

The existing AI Gateway remains responsible for AI-specific pooled quota, provider, and OAuth semantics during the migration. The first spike must prove whether agentgateway belongs in front of it, alongside it, or only in the generic provider path. It must not silently replace working AI Gateway behavior.

Native GitHub tools are a special case. `git`, `gh`, and `gh-axi` need short-lived Assignment-scoped credentials or a provider-aware broker; a generic HTTPS proxy cannot safely inject authorization through CONNECT without TLS interception.

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
- Ordinary Internet access continues when the credentialed access plane is unavailable.

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

## Source references

- [Agentgateway standalone overview](https://agentgateway.dev/docs/standalone/main/)
- [Agentgateway generic routes](https://agentgateway.dev/docs/standalone/main/configuration/routes/)
- [Agentgateway HTTP authorization](https://agentgateway.dev/docs/standalone/latest/configuration/security/http-authz/)
- [Agentgateway external authorization](https://agentgateway.dev/docs/standalone/latest/configuration/security/external-authz/)
- [Agentgateway backend authentication](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/)
- [Agentgateway OAuth token exchange](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/oauth-token-exchange/)
- [Agentgateway dynamic configuration](https://agentgateway.dev/docs/standalone/latest/configuration/static-configuration/)
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

The resilience epic remains the top-level program. Existing issue #27 becomes the nested provider-access epic. A new nested Effect migration epic tracks the TypeScript program. Both own independently releasable subissues with explicit acceptance criteria; the parent resilience epic owns cross-cutting ordering and conformance.

Implementation plans must be written per subissue after this design is reviewed. The agentgateway spike is a decision gate: production rollout and controller adoption are not implied by selecting it for evaluation.
