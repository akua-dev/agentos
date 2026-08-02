# ACP/A2A resilience conformance

Issue: [#130](https://github.com/akua-dev/agentos/issues/130)

Status: **hard gate implemented; protocols remain ineligible when any required
observation is missing, unprotected, content-bearing, too slow to revoke, or
not proven in the required disposable source**.

## Gate

`compileProtocolResilienceVerdict` owns a closed Effect Schema for one complete
run. It requires exactly one observation for all 42 released scenarios:

- Pi and Codex ACP create/load, metadata-only prompt control, tool/plan events,
  permission, cancellation, adapter loss, Pod/process replacement, exact native
  resume, and dual-writer rejection;
- A2A Agent Card, invoke, deliberate rejection of streaming/cancel/artifact,
  replay, timeout, gateway/authorizer/target/PostgreSQL loss, listener/Herdr
  recovery, exact parent-child allow, sibling/lateral/cross-domain denial,
  inactive Assignment, revoked profile, expired identity, guessed skill,
  content rejection, and bounded telemetry.

The verdict fails closed for a missing or duplicate scenario, a result that
does not match its frozen expectation, any Task/Assignment/Inbox/execution/
report mutation attributed to protocol transport, more than one ACP writer,
loss of provider-native session authority, Herdr becoming unattached, a
revocation observation above 60 seconds, content fields, dynamic metric labels,
unprotected trace correlations, production endpoint contact, unpinned images,
or missing teardown evidence.

Unsupported A2A operations pass only when they are observed as
`unsupported_rejected`; they are never counted as successful protocol work.
PostgreSQL remains the canonical work authority and ACP keeps the provider's
native session as the only session authority.

## Executable evidence map

| Matrix | Executable source |
| --- | --- |
| ACP metadata, custody, cancellation, permission, tool/plan and dual-writer behavior | `packages/agentos/src/harness-control/tests/acp.effect.test.ts` |
| A2A cards, invoke, replay, unsupported content/methods, timeout, policy and dependency failure | `services/a2a/tests/app.effect.test.ts` |
| A2A exact hierarchy, active Assignment, canonical projection, replay and function-only database authority | `database/tests/a2a-delivery.effect.test.ts` |
| TokenReview, identity expiry and revocation bounds | `packages/agentos/src/access/tests/identity.effect.test.ts` plus the disposable proof below |
| OpenFGA profile/ceiling/effective grant and revocation | `packages/agentos/src/access/tests/a2a-policy.effect.test.ts` and `control-plane.effect.test.ts` |
| Agentgateway A2A header, ext-auth, Task-shape and version behavior | `services/agentgateway/tests/a2a-v1.effect.test.ts` |
| Complete evidence semantics, privacy, cardinality, continuity and teardown | `packages/agentos/src/protocol/tests/resilience-conformance.effect.test.ts` |

## Disposable Kubernetes proof

The live proof refuses every context except a local
`kind-agentos-protocol-*` context, requires an explicit approval reference, and
checks that the API server resolves only to localhost before creating anything.
It then:

1. creates three uniquely named disposable namespaces;
2. issues one ten-minute, `agentos-egress-authz` audience ServiceAccount token;
3. verifies its TokenReview identity without logging the bearer;
4. proves exact First-Mate/child RBAC while denying a sibling and cross-domain
   ServiceAccount;
5. deletes the ServiceAccount and requires TokenReview denial within the
   60-second revocation SLO;
6. replaces separate Pi and Codex writer Pods and proves new Pod UIDs retain
   the same PVC UID and exact provider-native session reference; and
7. waits for deletion of every test namespace before it can return success.

The proof uses Effect Config, Schema, Redacted, Clock, Stream and the scoped
Effect process service. It contains no async function, ambient environment
read, native timer, thrown failure, type assertion, untyped JSON or nested
runtime.

On 2026-08-01 it passed twice on:

- Kind `v0.32.0`;
- Kubernetes node `kindest/node:v1.36.1` at
  `sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5`;
- Docker `29.4.0`;
- local context `kind-agentos-protocol-130`;
- repository base revision `a0b1e09d2710c88f084fae3e7edf9f61433b541e`.

The final successful combined identity, revocation, Pi replacement, Codex
replacement and namespace-cleanup run took 30.41 seconds. No production
endpoint was contacted. The cluster was deleted after evidence collection.

Run the live proof only against a newly created disposable cluster:

```sh
AGENTOS_KUBERNETES_TEST_CONTEXT=kind-agentos-protocol-130 \
AGENTOS_DISPOSABLE_FLEET_APPROVAL=approval:issue-130-disposable \
bun node_modules/vitest/vitest.mjs run \
  packages/agentos/src/protocol/tests/disposable-kubernetes.effect.test.ts
```

Without both variables, the live observation is explicitly logged as
unobserved. An unobserved live subset cannot be submitted to the hard gate as
Fleet-eligibility evidence.
