# Effect-native provider access plane implementation plan

**Issues:** #94, #96, #105; enables #92, #106, #107, and #109

**Goal:** Run a production-ready AgentOS authorizer that authenticates an exact
live Kubernetes workload, resolves its authoritative AgentOS identity, checks
the currently effective profile and ceiling through OpenFGA, and returns a
short-lived provider grant to agentgateway without ever exposing provider
credentials or making ordinary Internet depend on this plane.

**Architecture:** A private `agentos-egress-authz` service receives only
agentgateway external-authorization requests. Its Effect program reviews the
projected workload token with Kubernetes, re-reads the bound Pod and
ServiceAccount, resolves the Agent and active Assignment from PostgreSQL,
resolves the current profile/ceiling version, and performs a higher-consistency
OpenFGA check. Provider adapters accept only the resulting 15-second grant.
Kustomize remains the AgentOS deployment authority. Regular Internet traffic is
direct and independent.

**Effect invariant:** Every new and modified TypeScript path in this plan uses
Effect for configuration, I/O, HTTP, SQL, concurrency, resources, retries,
timeouts, cancellation, tests, and observability. Pure helpers may remain pure
but cannot hide effects. The only runtime invocation is the named outer Bun
entry adapter; it immediately enters one managed runtime and contains no domain
logic. No internal `runPromise`, `async`/`await`, raw `fetch`, raw filesystem,
ambient environment access, or thrown domain error is permitted.

---

## Task 1: Establish the repository-wide Effect gate

- Extend `tooling/effect-migration` with a complete TS/TSX inventory and a
  checked boundary-allowlist schema containing path, boundary kind, reason,
  owner issue, test, and removal condition.
- Make raw Promise/`async`, `runPromise`, fetch, filesystem, process, database,
  timer, environment, throw, and ad hoc parser findings fail unless they match
  one exact reviewed outer adapter entry.
- Add failing policy fixtures for services, tests, scripts, CLIs, website,
  browser, extensions, and generators before implementing the gate.
- Register existing debt against #97-#105 without granting directory-wide
  exceptions. Newly added files must pass with zero escapes.

## Task 2: Replace the legacy OpenFGA HTTP bridge

- Characterize status, timeout, interruption, size-limit, response-schema, and
  secret-redaction behavior in `openfga-http` tests.
- Replace the `fetchImpl: Promise<Response>` port with Effect Platform
  `HttpClient`; tests supply a Layer rather than Promise callbacks.
- Preserve immutable store/model IDs and require `HIGHER_CONSISTENCY` for live
  authorization decisions and rollout acknowledgement.
- Keep the OpenFGA pre-shared key scoped to the authorizer/bootstrap/readiness
  workloads and out of errors, logs, spans, and defects.

## Task 3: Implement live Kubernetes identity adapters test-first

- Add closed Effect Schema contracts for TokenReview, Pod, ServiceAccount, and
  Kubernetes Status responses, including bounded bodies and exact excess-field
  handling where AgentOS owns the contract.
- Implement `KubernetesTokenReviewer` and
  `KubernetesWorkloadIdentityLookup` with Effect Platform `HttpClient`, the
  mounted cluster CA/token through Effect `FileSystem`, bounded timeouts, and
  typed dependency errors.
- Require the `agentos-egress-authz` audience, exact ServiceAccount and Pod UID
  extras, live Running Pod, live ServiceAccount, and matching Pod ownership.
- Prove interruption, 401/403/404/409/429/5xx, malformed/oversized response,
  CA/auth failure, token redaction, and no negative caching.

## Task 4: Implement the PostgreSQL identity and policy stores

- Add a dedicated least-privilege `agentos_egress_authz` database identity that
  can only read the exact Agent, active Assignment, access binding, profile
  head/version, ceiling, and rollout state required for decisions.
- Use Effect SQL PostgreSQL with scoped pools and closed Schema decoding; raw
  SQL migrations remain authoritative.
- Implement `AgentOSWorkloadIdentityStore` with exact namespace/Pod lookup and
  an unambiguous active-Assignment query.
- Add an Effect `ProviderPolicySnapshotStore` that returns one immutable,
  internally consistent binding/profile/ceiling snapshot and rejects pending,
  stale, disabled, expired, or unreconciled versions.
- Test role privileges, transaction consistency, duplicate rows, stale rollout,
  interruption, pool exhaustion, database restart, and redacted failures.

## Task 5: Implement the concrete policy decision point

- Translate the normalized workload identity and resolved route to canonical
  AgentOS subject/resource names and the finite OpenFGA capability relation.
- Check both the active profile and current ceiling using the pinned model and
  current-time condition context with higher consistency.
- Return profile, ceiling, rate class, expiry, and an opaque decision reference
  only when both policy layers allow; never accept caller-supplied identity or
  policy headers.
- Keep denial, identity, stale-policy, OpenFGA-dependency, database-dependency,
  invalid-route, and rate/budget outcomes distinct and content-free.
- Prove a denied request never reaches a provider adapter or credential volume.

## Task 6: Build the Effect-native authorizer HTTP service

- Add `services/egress-authz` with Config, Layers, redacted secrets, an Effect
  Platform HTTP application, and one `BunRuntime.runMain` outer entry adapter.
- Support the exact agentgateway external-authorization request/response
  contract plus `/livez` and `/readyz`; reject unsupported methods/routes,
  caller grant headers, oversized headers/bodies, and malformed bearer tokens.
- Bound request concurrency, body size, identity/policy cache TTL, dependency
  timeouts, and graceful shutdown using Effect scopes and structured
  concurrency.
- Return stable typed status/reason codes and only the signed/opaque grant
  metadata required by downstream credential adapters.
- Add `@effect/vitest` tests for cancellation, finalizers, overload, malformed
  input, dependency failure, grant expiry, header scrubbing, and privacy.

## Task 7: Add semantic readiness and revocation

- Readiness checks Kubernetes TokenReview permission, Kubernetes object lookup,
  PostgreSQL identity/policy queries, exact OpenFGA store/model readiness, and
  reconciled policy/profile/ceiling versions without requiring a provider
  credential or consuming a real provider request.
- Report one bounded typed dependency summary; never emit tokens, SQL text,
  credentials, prompts, provider bodies, or dynamic identities.
- Listen to durable AgentOS policy/identity operation notifications through an
  Effect Stream, invalidate positive caches immediately, and reconcile missed
  notifications after reconnect/restart from the operation journal.
- Prove selected Agent/Assignment/profile/ceiling revocation meets the 60-second
  SLO, survives Pod restarts, and does not deny unrelated identities.

## Task 8: Deploy with owned Kustomize resources

- Add a two-replica Deployment, private Service, dedicated ServiceAccount,
  least-privilege TokenReview/Pod/ServiceAccount RBAC, PDB, topology spread,
  resource requests/limits, non-root security, probes, and isolated ingress
  NetworkPolicy.
- Mount only Kubernetes API trust, authorizer database credentials, OpenFGA
  client credentials, and immutable deployment IDs; never mount provider
  credentials in the authorizer or Agent credentials in provider adapters.
- Wire agentgateway external authorization to the Service and retain explicit
  provider endpoints. Do not set a universal `HTTP_PROXY`, intercept TLS, or
  add default-deny Internet egress.
- Add rendered-manifest assertions for RBAC, identity, secret isolation,
  readiness, update strategy, ordinary-Internet independence, and pinned
  agentgateway/OpenFGA versions.

## Task 9: Add privacy-safe telemetry and operations

- Emit OTel spans/metrics for bounded Fleet/domain/role, route class,
  capability, policy version class, adapter/provider, decision category,
  dependency, latency, cache result, and readiness outcome.
- Put Agent/Mate/Assignment/correlation IDs only in bounded trace attributes or
  logs where operationally required; never use them as metric labels.
- Machine-check rejection of prompts, memory, provider bodies, tool payloads,
  bearer tokens, provider credentials, SQL parameters, and raw dependency
  errors.
- Document and exercise install, upgrade, rollback, backup/restore, stale-model
  recovery, adapter compromise, surgical kill switch, and direct-provider
  break-glass runbooks.

## Task 10: Conformance, landing, and issue synchronization

- Run focused Effect, SQL privilege, manifest, agentgateway, OpenFGA, provider
  adapter, privacy, revocation, and outage tests.
- Exercise a disposable Fleet matrix for authorizer restart, TokenReview
  failure, Pod/ServiceAccount replacement, PostgreSQL/OpenFGA outage, stale
  policy, revoked identity, malformed request, overload, rolling upgrade, and
  rollback.
- Prove ordinary Internet remains available during total access-plane outage
  while every credentialed provider path fails closed without secret exposure.
- Run the repository Effect gate, full local check, production image tests, and
  normal GitHub CI. Land reviewable PR slices in dependency order.
- Update #94/#96/#105 after each slice; close #94 only after live identity and
  policy integration, close #96 only after operations/conformance, and close
  #105 only after all AI/provider-access legacy TypeScript has migrated.
