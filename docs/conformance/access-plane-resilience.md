# Provider-access resilience child gate

Issues: [#92](https://github.com/akua-dev/agentos/issues/92),
[#94](https://github.com/akua-dev/agentos/issues/94)

Status: **implemented as a mandatory child of the AgentOS resilience hard
gate**. A release is ineligible unless one clean revision proves all 38 closed
scenarios, the live Kubernetes boundary, actual native GitHub clients, exact
regression-source execution, privacy, cleanup, and ordinary Internet
independence.

## Authority and invariants

- Kubernetes TokenReview plus current Pod and ServiceAccount objects establish
  workload identity. Caller fields and a bearer alone establish nothing.
- PostgreSQL establishes Agent/Assignment custody and the current immutable
  profile, binding, ceiling, rate, budget, and operation state.
- OpenFGA evaluates the pinned model and effective subject/resource grant.
- A denied or unavailable decision reaches neither the provider adapter nor its
  credential authority.
- The provider adapter alone holds and refreshes the upstream credential.
- Ordinary Internet requests bypass the governed credential path. This gate
  introduces no blanket egress block, Helm migration, Vault, or OpenBao.
- Every AgentOS-owned TypeScript path remains under the repository's Effect
  policy. Config, Schema, Effect Platform, scoped resources, Stream, Clock, and
  tagged errors own every operational boundary.

## Closed matrix

| Scenario | Required result | Minimum evidence |
| --- | --- | --- |
| `identity.impersonation_denied` | denied: impersonation | Effect fixture |
| `identity.wrong_audience` | denied: audience mismatch | disposable Kubernetes |
| `identity.expired_token` | denied, then projection refresh | Effect fixture |
| `identity.stale_pod_uid` | denied within 60 s under load | disposable Kubernetes |
| `identity.deleted_pod` | denied within 60 s under load | disposable Kubernetes |
| `identity.stale_serviceaccount_uid` | denied within 60 s under load | disposable Kubernetes |
| `identity.deleted_serviceaccount` | denied within 60 s under load | disposable Kubernetes |
| `identity.assignment_ended` | denied after verified policy reload | PGlite |
| `identity.exact_custody` | allowed for one exact live identity | Effect fixture |
| `authorization.profile_allow` | allowed by profile plus ceiling | PGlite |
| `authorization.scope_mismatch` | denied before forwarding | PGlite |
| `authorization.profile_rebind` | allowed after reload within 15 s | disposable Kubernetes |
| `authorization.binding_revocation` | denied after reload within 15 s | disposable Kubernetes |
| `authorization.ceiling_shrink` | removed grant remains denied | PGlite |
| `authorization.openfga_consistency` | higher-consistency denial | PGlite |
| `authorization.rate_effective_zero` | rate-disabled denial | PGlite |
| `authorization.budget_kill_switch` | budget-exhausted denial | PGlite |
| `authorization.unrelated_subject_continuity` | unrelated subject remains allowed | disposable Kubernetes |
| `dependency.tokenreview_outage` | typed unavailable, fail closed | Effect fixture |
| `dependency.postgresql_outage` | typed unavailable, recoverable | PGlite |
| `dependency.openfga_outage` | typed unavailable, fail closed | Effect fixture |
| `dependency.authorizer_outage` | typed unavailable, fail closed | Effect fixture |
| `dependency.agentgateway_outage` | typed unavailable, fail closed | Effect fixture |
| `dependency.provider_adapter_outage` | typed unavailable, no credential fallback | Effect fixture |
| `credential.provider_expiry_refresh` | adapter-local refresh then completion | Effect fixture |
| `credential.projected_token_rotation` | new projection reread | disposable Kubernetes |
| `transport.bounded_retry` | bounded retry without duplicate forward | Effect fixture |
| `transport.stream_completion` | native completion and one settlement | Effect fixture |
| `transport.cancellation` | cancellation and one settlement | Effect fixture |
| `transport.failure` | provider failure and one settlement | Effect fixture |
| `settlement.exactly_once` | exactly one idempotent settlement | PGlite |
| `internet.ordinary_continuity` | direct Internet remains available | disposable Kubernetes |
| `native.github_rest` | scoped REST semantics preserved | Effect/native fixture |
| `native.github_graphql` | bounded repository GraphQL semantics | Effect fixture |
| `native.git_smart_http` | smart-HTTP status and stderr preserved | Effect/native fixture |
| `native.git_projected_identity` | fresh token, no persisted login | Effect/native fixture |
| `native.gh_projected_identity` | fresh token, no persisted login | Effect/native fixture |
| `native.gh_axi_projected_identity` | fresh token, no persisted login | Effect/native fixture |

Every scenario has exactly one original and one distinct held-out
`it.effect` reference. The source verifier requires both exact titles to exist,
and the execution attestor requires each referenced assertion to occur exactly
once with status `passed` in the hard gate's Vitest JSON report.

## Live Kubernetes proof

Hard mode accepts only a local `kind-agentos-access-*` or
`kind-agentos-resilience-*` context whose API endpoint resolves to loopback. It
creates a unique `agentos-access-92-*` namespace containing three isolated
ServiceAccounts and probe Pods. Each Pod disables automatic token mounting and
receives only an explicit 600-second, `agentos-egress-authz` audience-bound
projection.

The scoped Effect then proves:

- a wrong-audience token fails TokenReview;
- a deleted Pod's bound token stops authenticating under 32 concurrent reviews;
- recreating the same Pod name produces a different token and UID while the old
  token remains denied;
- ServiceAccount deletion and same-name recreation likewise leave the old UID
  token denied;
- an unrelated identity remains authenticated and authorized;
- a RoleBinding replacement is visible under 32 concurrent authorization
  checks within the 15-second reload SLO; and
- `wget http://example.com` succeeds while the governed access services are
  deliberately absent.

The Kubernetes reload measurement proves real API-server/RBAC visibility under
load. AgentOS profile, ceiling, OpenFGA-consistency, budget, and journal
semantics remain proven by their exact PGlite/model regressions; the live test
does not create a shadow authorization authority.

The same namespace also exercises provider rollout custody. A two-replica
probe Deployment holds both previous replicas Ready while an intentionally
unready revision is withheld, remains reachable from the unrelated workload,
rolls back through native retained ReplicaSet history, and later completes one
good upgrade. The hard-gate evidence Schema requires all four rollout facts to
be true. Cross-authority acknowledgement is separately compiled by the closed
Effect `compileProviderAccessRolloutVerdict`; no configuration, policy,
credential or budget mismatch can be reported verified.

The artifact contains only the context and approval reference, revocation and
reload milliseconds, load count, rollout booleans, and cleanup result. Tokens
remain `Redacted` in memory and are never encoded, logged, or persisted.
Effect finalizers delete the namespace on success, failure, or interruption.

## Native-client proof

Hard mode also starts a scoped local TLS fixture and validates that the Docker
image named by `AGENTOS_RESILIENCE_AGENTOS_IMAGE` has the exact
`AGENTOS_RESILIENCE_AGENTOS_IMAGE_DIGEST` image ID. A disposable Docker volume
installs the lockfile-pinned Linux `gh`; the actual installed `gh-axi` and host
`git` then use that same selected `gh` boundary.

The proof rotates a JWT-shaped canary value before each client invocation.
`gh`, `gh-axi`, and Git smart HTTP must all reach the fixture and preserve its
native failure status and stderr. The fixture records only authorization-header
lengths and requires three distinct lengths, proving per-call token reread
without retaining token values. No `hosts.yml`, credential store, remote URL,
argument, output, or durable file may contain the identity. The one-day CA,
server key, files, server, and Docker volume are scoped and finalized.

`gh-axi` invokes the literal `gh` executable on `PATH`. The AgentOS helper
therefore prepends the configured `gh` binary directory to the native child's
`PATH`; setting an unused custom environment variable is not treated as proof.

## Audit, privacy, and failure behavior

The gate composes exact access-contract and telemetry-contract assertions with
the scenario references. Every synthesized observation is eligible only after
those assertions pass, and requires a protected, complete audit event with
bounded metric dimensions. Tokens, credentials, identity payloads,
request/response bodies, Git/tool payloads, provider identities, prompts,
briefs, transcripts, and memory are forbidden.

Identity, policy, dependency, rate, and budget denial must show zero provider
forwards and zero credential releases. Completion, provider rejection,
transport failure, and cancellation must preserve native semantics and settle
exactly once. An audit or telemetry sink failure cannot change authorization or
provider behavior.

## Running the gate

Ordinary tests execute the deterministic contracts and explicitly leave live
proof unobserved when hard-mode configuration is absent. Promotion uses the
single parent command and exact-revision procedure documented in the
[AgentOS resilience runbook](./agentos-resilience.md#disposable-runbook).

Useful focused checks are:

```sh
bunx vitest run packages/agentos/src/access/tests
bunx vitest run packages/agentos/runtime/tests/github-workload-auth.effect.test.ts
bun run effect:check
```

The parent command must pass twice for the same clean commit. After both runs,
inspect namespace cleanup read-only and delete only the approved disposable
Kind cluster.
