# AgentOS egress authorizer

`agentos-egress-authz` is the private HTTP external-authorization service used
by AgentGateway for governed provider routes. It is an Effect Platform Bun
application from configuration through shutdown. The only runtime execution is
the reviewed `BunRuntime.runMain` call in `src/main.ts`.

For every `/authorize` request the service:

1. rejects unsupported routes, methods, forged grant headers, oversized
   metadata and overload before authentication;
2. reviews the caller's audience-bound ServiceAccount JWT with Kubernetes and
   resolves the live Pod, ServiceAccount, Agent and optional Assignment;
3. reads the exact active binding, access profile and First-Mate ceiling from
   PostgreSQL;
4. performs the profile, ceiling and effective-subject checks against the
   pinned OpenFGA store/model with higher consistency;
5. atomically reserves the subject/route's durable request and concurrency
   capacity in PostgreSQL; and
6. returns only a closed grant with a maximum 15-second lifetime and a lease
   bounded by that reservation.

`POST /settle` is a separate private provider boundary. It accepts at most a
4 KiB closed terminal-usage report, authenticates a live Pod-bound token for
the dedicated `agentos-provider-budget-settlement` audience, and derives the
provider and credential domain from the exact registered ServiceAccount. Its
body cannot select a Mate, Assignment, provider or credential domain.

It never receives a provider credential and never forwards provider traffic.
Tokens, authorization values, prompts, request bodies, policy documents and
dependency error text are absent from responses and lifecycle logs. Requests
are interruptible, bounded by an immediate concurrency permit and timeout, and
release their permit when the client disconnects or the fiber is interrupted.

`GET /livez` proves only that the HTTP process is alive. `GET /readyz` requires
the exact PostgreSQL function privileges needed for identity, policy,
reservation and provider settlement plus the health tuple in the pinned
OpenFGA model. `GET /readyz/settlement` additionally requires the caller's
current `agentos-provider-budget-settlement` Pod token to pass TokenReview and
live Pod/ServiceAccount lookup before returning ready. It performs no budget
mutation. Authorization and settlement fail closed while any required
dependency is unavailable. There is no independent policy-decision cache: each
authorization observes current PostgreSQL and OpenFGA state. The
workload-identity cache remains bounded by the shorter of the projected-token
expiry and 15 seconds.

Rate limits, exhausted token/spend budgets and binding-local effective-zero
kill switches are enforced by one atomic reservation function that revalidates
the current PostgreSQL policy. They survive Pod and process restarts and do not
depend on telemetry. Stable `429` denial envelopes keep `rate_limited` and
`budget_exhausted` distinct from policy, dependency and upstream-provider
failures. See the
[provider-budget design](../../docs/security/provider-budget-enforcement.md).

## Deployment

Kustomize is the deployment authority:

```sh
kubectl kustomize services/egress-authz/kubernetes
kubectl apply -k services/egress-authz/kubernetes
```

Deploy the AgentOS PostgreSQL schema and OpenFGA bootstrap first. The Deployment
expects the managed `agentos-egress-authz-database` Secret key `database-url`
for the dedicated non-privileged `agentos_egress_authz` login, the
`openfga-admin` Secret key `preshared-key`, and the bootstrap-generated
`openfga-deployment` ConfigMap. It deliberately avoids CloudNativePG's
`agentos-postgres-app` owner credential as a runtime dependency. All inputs are
mounted as files; secret values are never accepted directly through environment
variables. The schema owner must run
`configure_egress_authorizer_privileges('agentos_egress_authz')` after every
migration before readiness is enabled.

The Service is private at
`agentos-egress-authz.agentos.svc.cluster.local:9001`; there is no Ingress. Its
NetworkPolicy restricts inbound traffic to core-namespace Pods with a registered
credential-domain label—AgentGateway for authorization and provider adapters
for settlement—but has no egress policy. Agent and service Pods retain ordinary
direct Internet access.
The authorizer's ClusterRole is limited to creating TokenReviews and getting
Pods and ServiceAccounts so it can validate identities across Fleet and domain
namespaces.

Configuration is read with Effect Config. Defaults are production-safe and can
be overridden through the bounded settings in `src/config.ts`; credential
settings name mounted files only. Invalid ports, limits, URLs, environment
names, secret files or pinned OpenFGA IDs stop startup with a content-free
tagged failure.

## Verification

```sh
bunx vitest run services/egress-authz/tests \
  database/tests/provider-budget-enforcement.effect.test.ts
bun run effect:check
bun run typecheck
kubectl kustomize services/egress-authz/kubernetes
```

The tests cover the Effect Platform router, malformed input, readiness failure,
overload, timeout interruption, semaphore finalization, redacted file loading,
the live dependency graph, image wiring and rendered Kubernetes/RBAC/network
boundaries.
