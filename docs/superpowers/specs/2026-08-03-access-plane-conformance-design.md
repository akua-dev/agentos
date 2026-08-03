# Workload-identity access-plane conformance design

**Issue:** #92; completes evidence required by #94 and contributes to #96,
#107, #27, #56, and #85

## Outcome

Make promotion ineligible unless one exact AgentOS revision proves the
workload-identity access plane's identity, authorization, hot-reload,
revocation, dependency-failure, native-client, privacy, and ordinary-Internet
properties without contacting a production provider or exposing a credential.

This design refines the already approved provider-access architecture in
`2026-07-31-resilient-delegation-access-effect-design.md`. It does not change
the access-plane product architecture.

## Approaches considered

### Selected: composable access child gate inside the #84 runner

Add a closed Effect-native access conformance contract and compose its eligible
verdict into the existing AgentOS resilience hard gate. Exact existing
regressions provide deterministic and PGlite evidence. One reusable disposable
Kubernetes Effect contributes the cases that require a real API server,
projected identity, revocation timing, native clients, or network isolation.

This gives one promotion command, one revision/approval/image boundary, one
sanitized artifact lifecycle, and no contradictory second harness.

### Rejected: only cite the existing scattered tests

The existing tests cover most mechanics, but a collection of green files does
not prove completeness, evidence strength, exact revision continuity, privacy,
or a closed failure taxonomy. It also cannot fail when a required case is
silently removed.

### Rejected: build an independent end-to-end access test cluster

A separate cluster harness would duplicate #84's Kind approval, image pins,
identity proof, cleanup, and attestation logic. It would increase drift and
could claim success against a different revision. The access proof must be a
child of the existing gate instead.

## Closed scenario groups

The child contract freezes these groups and gives every scenario an expected
decision, stable failure class, recovery, maximum SLO where applicable,
minimum evidence source, and two distinct Effect regression references.

### Identity

- caller-controlled or impersonated identity;
- wrong TokenReview audience;
- expired projected token;
- stale Pod UID, deleted Pod, stale ServiceAccount UID, and deleted
  ServiceAccount;
- inactive or ended Assignment; and
- exact Mate/Assignment/workload custody success.

### Authorization and hot reload

- exact profile allow and capability-scope mismatch;
- profile rebind and binding revocation;
- ceiling shrink and effective-grant removal;
- higher-consistency OpenFGA denial after mutation;
- effective-zero rate class and surgical kill switch; and
- unrelated Mate/profile continuity during every mutation.

### Dependency and credential lifecycle

- Kubernetes TokenReview, PostgreSQL, OpenFGA, authorizer, agentgateway, and
  provider-adapter outage;
- provider credential expiry and adapter-local refresh;
- kubelet-projected caller-token rotation;
- bounded retries without duplicate provider forwarding;
- streaming completion, cancellation, transport failure, and exactly-once
  settlement; and
- ordinary ungoverned Internet continuity during total access-plane outage.

### Native GitHub and audit behavior

- REST, GraphQL, and Git smart-HTTP native status, stream, and stderr behavior;
- `git`, `gh`, and `gh-axi` reread projected identity without persisted login;
- no denied request reaches a provider adapter;
- no failed authorization releases an upstream credential;
- complete bounded audit for allow, deny, rate, budget, cancellation, and
  provider outcomes; and
- no token, credential, request/response body, Git payload, tool payload,
  provider identity, or dynamic identifier in metrics.

## Architecture

### Access conformance contract

`packages/agentos/src/access/resilience-conformance.ts` owns strict Effect
Schemas for scenario observations and a complete run. The compiler rejects
missing, duplicate, unobserved, failed, mismatched, weak, slow, content-bearing,
high-cardinality, unprotected, unaudited, provider-reaching-on-denial, or
credential-releasing-on-denial evidence.

The verdict records bounded counts and authority invariants only. It never
contains a token, decision body, profile body, repository URL, provider body,
or dynamic identity.

### Executed-source attestation

The #84 execution attestor gains the access child references and requires each
exact repository-relative `*.effect.test.ts` file and `it.effect` title to pass
once. The source verifier requires one original and one genuinely different
held-out regression for every access scenario.

The caller still cannot submit observations. The gate derives them from the
closed scenario registry only after the exact executed matrix and live artifact
pass.

### Disposable Kubernetes program

The reusable program runs under the existing
`AGENTOS_RESILIENCE_HARD_GATE=true` contract and shared
`kind-agentos-resilience-*` context. It creates unique disposable namespaces
and uses only pinned public fixture images and canary credentials that have no
provider value.

It proves real projected-token audience/rotation/revocation, Pod and
ServiceAccount UID binding, denial before the canary adapter, one bounded
revocation/hot-reload load probe, unrelated-subject continuity, native GitHub
transport semantics against a credential-free fixture, and ungoverned outbound
connectivity while the governed access services are unavailable. It records a
Schema-encoded artifact containing bounded booleans, durations, digests, and
counts only. Effect finalizers remove every generated resource on success,
failure, or interruption.

PostgreSQL/OpenFGA policy transitions remain authoritative in their existing
PGlite/model tests. The live program does not create a shadow authorization
model merely to make a cluster test convenient.

## Data and authority flow

1. The workload presents a fresh audience-bound ServiceAccount token.
2. TokenReview plus live Pod/ServiceAccount reads resolve immutable workload
   identity.
3. PostgreSQL resolves exact Agent/Assignment custody and one immutable
   binding/profile/ceiling snapshot.
4. OpenFGA checks the profile, ceiling, and effective subject with higher
   consistency.
5. The budget authority reserves exact subject/route capacity.
6. The adapter alone receives an upstream canary credential after allow.
7. Terminal forwarding settles exactly once; audit and protected trace evidence
   contain bounded outcome metadata only.

No later stage may override a denial or missing earlier authority. Ordinary
Internet traffic that does not request a managed provider credential bypasses
this path entirely.

## Failure and recovery

Credentialed routes fail closed with distinct identity, policy, dependency,
rate, budget, provider-authentication, provider-rate, transport, stream, and
cancellation results. No dependency outage falls back to the adapter
credential. Telemetry failure remains fail-open and cannot alter a decision or
budget.

Token and provider credentials are reread at call time. Bounded refresh may
recover an expired upstream credential, but identity/profile/binding/ceiling
revocation is never retried into an allow. Hot reload succeeds only after the
PostgreSQL and OpenFGA versions are both verified. An interrupted mutation
remains visibly pending and old authority is not acknowledged as new policy.

## Effect invariant

Every AgentOS-owned TypeScript module is governed by the repository Effect
policy, and every operational path is Effect-native. This is a hard invariant,
not a migration preference and not limited to the files introduced by this
issue. Config owns environment input; Effect Schema owns artifacts and
boundaries; Effect Platform owns HTTP, filesystem, subprocess, and Kubernetes
access; Effect SQL/PGlite owns database tests; Clock, Schedule, Stream, and
structured concurrency own time and load; scoped finalizers own cleanup; and
tagged errors own every failure.

No AgentOS-owned path may introduce raw `async`/`Promise` orchestration,
`fetch`, Node filesystem/process/network/timer effects, ambient configuration,
thrown domain errors, assertion casts, ad hoc JSON parsing, or nested runtime
execution. Host entry points remain named, one-way adapters that run one
top-level Effect and contain no domain logic. The all-TypeScript Effect policy
is a promotion-blocking check, and the access gate cannot weaken, exclude, or
grandfather a violating path. No new runtime adapter is needed.

## Verification and promotion

- Failing-first contract tests cover every gate rejection.
- Exact existing unit/model/PGlite/native-client regressions are source-bound.
- New live assertions cover only behavior that requires Kubernetes or outbound
  network semantics.
- The ordinary Effect suites run without a cluster and explicitly mark live
  evidence unobserved.
- Hard mode fails when context, approval, artifact path, exact revision, image
  pin, or cleanup is absent.
- The same committed revision must pass twice on a newly created pinned Kind
  cluster, followed by read-only cleanup inspection and deletion of only that
  cluster.
- Full Effect policy, unit, integration, build, typecheck, website, and normal
  GitHub CI checks remain required.

The child issues remain open until their evidence is present on the default
branch. A stacked PR is evidence of implementation, not authority to close an
issue early.
