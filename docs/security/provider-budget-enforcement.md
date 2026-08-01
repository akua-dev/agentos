# Provider budget enforcement

Status: durable enforcement foundation for AgentOS issue #107.

AgentOS reserves governed provider capacity after current PostgreSQL policy and
higher-consistency OpenFGA authorization succeed, but before it returns an
authorization grant. PostgreSQL is authoritative; metrics, traces, gateway
process memory, Pod identity and process lifetime are not counters or policy.
An unavailable budget store therefore fails the governed route closed even
when telemetry is unavailable.

The implementation is Effect-native end to end:

- [`provider-budget.ts`](../../packages/agentos/src/access/provider-budget.ts)
  owns closed reservation, settlement, rate-class, error and service contracts;
- [`provider-budget-postgres.ts`](../../packages/agentos/src/access/provider-budget-postgres.ts)
  computes one SHA-256 subject/route key with Effect Crypto and calls only the
  narrow security-definer database functions through Effect SQL;
- [`provider-budget-settlement-http.ts`](../../packages/agentos/src/access/provider-budget-settlement-http.ts)
  rereads a rotating audience-bound Pod token for each closed settlement
  report and uses only Effect FileSystem, HTTP, timeout and stream boundaries;
- [`policy-decision.ts`](../../packages/agentos/src/access/policy-decision.ts)
  reserves capacity only after exact live policy and OpenFGA checks; and
- [`0020_provider_budget_enforcement.sql`](../../database/migrations/0020_provider_budget_enforcement.sql)
  atomically revalidates the binding and policy, locks deterministic windows,
  records reservations and settlements, and applies First-Mate overrides; and
- [`0021_provider_budget_provider_settlement.sql`](../../database/migrations/0021_provider_budget_provider_settlement.sql)
  removes subject-bearing settlement authority from the egress-authorizer
  role and exposes only exact provider/credential-domain settlement.

## Stable isolation key

The budget key is a one-way digest over the contract version, canonical Mate
or Assignment subject, provider, credential domain, capability, canonical
resource and environment. It deliberately excludes decision reference,
correlation ID, Pod name, Pod UID and ServiceAccount token. A Pod restart or
identity recreation therefore cannot reset capacity, while two Mates or a Mate
and Assignment cannot consume each other's counters.

Dynamic subjects, decisions, correlations and budget keys are persisted only
where needed for enforcement and bounded audit. They are not metric labels.
Credentials, authorization headers, prompts, provider request/response bodies,
provider payloads and arbitrary metadata are absent from every budget contract
and table.

## Captain-owned rate classes

The v1 registry is fixed in code and SQL. A profile selects a class inside an
exact Captain ceiling permission; it cannot define a new class or raise the
ceiling.

| Class | Requests/minute | Concurrent | Tokens/minute | Spend/hour | Reservation lease |
| --- | ---: | ---: | ---: | ---: | ---: |
| `disabled` | 0 | 0 | 0 | 0 | 15 minutes |
| `low` | 12 | 2 | 100,000 | 1,000,000 micros | 15 minutes |
| `standard` | 60 | 8 | 1,000,000 | 10,000,000 micros | 15 minutes |
| `high` | 300 | 32 | 10,000,000 | 100,000,000 micros | 15 minutes |

Request, token and spend windows use epoch-aligned boundaries, so reset time is
deterministic across replicas and restarts. A reservation consumes one request
and one concurrency lease. Settlement releases concurrency and records input,
output, cached-input and spend values exactly once. Cached input is a subset of
input tokens, not additional token consumption. Exact retries are idempotent;
conflicting reuse of a decision or operation identity fails closed.

An expired lease prevents an abandoned call from holding concurrency forever.
Provider components must settle every terminal result (`completed`,
`cancelled`, `provider_rejected`, or `transport_failed`) so token and spend
usage becomes authoritative promptly. `agentos-egress-authz` exposes a private
`POST /settle` endpoint. Its body cannot name a subject, provider or credential
domain: a dedicated Kubernetes TokenReview audience binds the live Pod and
ServiceAccount, and a finite registry derives those two authority fields.

The GitHub broker settles after a streamed response terminates, distinguishes
native provider rejection, downstream cancellation and transport failure, and
uses zero token/spend values. A settlement dependency failure never replaces
the provider response; the still-active 15-minute lease remains the fail-closed
fallback. The OpenAI adapter remains required before #107 can close.

## Surgical kill switches

First Mate can create an immutable, auditable override for one exact binding,
profile version, capability or canonical route. Runtime evaluation takes the
minimum of the base class and all matching active overrides, so an override can
only tighten access. `disabled` is an effective-zero kill switch. It blocks the
next governed credentialed call without changing another subject or route.

The mutation function requires the First-Mate database actor, an idempotent
operation UUID, exact target, finite reason, correlation ID, request digest and
ServiceAccount UID. Allowed reasons are `least_privilege`,
`operator_request`, `incident_response`, and `break_glass`. Break-glass means an
audited removal of an existing override; it cannot raise a rate class, bypass a
Captain ceiling or manufacture access. Every set/revoke appends immutable
control audit and emits `agentos_access_control` notification for bounded
invalidation consumers.

The egress-authorizer role cannot select counters, mutate overrides or invoke
the subject-bearing settlement function. It can only read the already-minimized
policy snapshot, reserve capacity, and settle an exact reservation for the
provider/credential domain authenticated at the HTTP boundary. First-Mate roles
can invoke the narrow override mutation and no provider credential is involved.

## Failure and network behavior

`rate_class_disabled`, `rate_limited`, and `budget_exhausted` remain distinct
typed failures. The HTTP authorizer returns stable `429` envelopes and
`x-agentos-denial-reason` for rate or budget exhaustion; this distinguishes an
AgentOS decision from policy `403`, dependency `503`, credential failures, and
an upstream provider's unmodified `429` response.

This is selective governed-provider enforcement. It does not install a global
forward proxy, TLS interception, default-deny egress policy or full egress
block. Ordinary unauthenticated Internet traffic remains direct and independent
of PostgreSQL, OpenFGA, AgentGateway and this budget service.

## Verification

```sh
bunx vitest run database/tests/provider-budget-enforcement.effect.test.ts \
  packages/agentos/src/access/tests/provider-budget.effect.test.ts \
  packages/agentos/src/access/tests/provider-budget-postgres.effect.test.ts \
  packages/agentos/src/access/tests/provider-budget-settlement.effect.test.ts \
  packages/agentos/src/access/tests/provider-budget-settlement-http.effect.test.ts \
  packages/agentos/src/access/tests/policy-decision.effect.test.ts \
  packages/agentos/src/access/tests/http-authorizer.effect.test.ts \
  services/egress-authz/tests services/github-broker/tests
bun run effect:check
bun run --cwd database migration:check
bun run typecheck
```
