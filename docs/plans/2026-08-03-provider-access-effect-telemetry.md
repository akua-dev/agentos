# Provider-access Effect telemetry implementation plan

**Issue:** #96
**Base:** `b2f4e49ab0dfc5f77f180711714e10af35262302`
**Constraint:** every AgentOS TypeScript path remains Effect-native.

## Outcome

Correlate one governed provider request from the workload-facing AgentGateway
route through authorization, policy, credential release, provider adapter and
provider outcome. Identity and policy identifiers remain span-only; metrics use
only finite route, adapter, decision, dependency and outcome dimensions. No
request body, response body, credential, provider identity or arbitrary header
is observed.

## Design

- Add one shared `ProviderAccessTelemetry` Effect service with an idempotent
  request lifecycle. It accepts only typed finite route/adapter/provider and
  terminal outcome values, correlates an already-validated authorization grant,
  and contains all tracing, logging or metric defects.
- Continue a valid W3C `traceparent` without retaining arbitrary propagation
  headers. Put Fleet/workload coordinates in resource attributes, Mate,
  Assignment and policy coordinates on spans, and exclude every identifier from
  metric labels.
- Instrument `agentos-egress-authz` around its raw typed failure boundary so a
  Kubernetes, PostgreSQL or OpenFGA outage remains attributable before the HTTP
  response is reduced to the content-free public envelope.
- Instrument `github-broker` across grant validation, scoped installation-token
  acquisition and the full provider response stream. End and settle each
  request exactly once for completion, rejection, transport failure or
  cancellation.
- Export both services through the existing Fleet OTLP collector. Keep native
  AgentGateway tracing enabled and keep prompt/content request logging disabled.

## TDD and verification

1. Add failing contract/runtime tests for finite dimensions, span-only
   identifiers, W3C continuation, idempotent terminal behavior and privacy.
2. Add failing authorizer tests for exact dependency classification and grant
   correlation.
3. Add failing broker tests for withheld/released credentials and every provider
   terminal outcome, including stream cancellation.
4. Implement the shared Effect telemetry runtime and service wiring.
5. Update collector allowlists, Kubernetes resource attributes and OTLP client
   labels; verify exact Kustomize renders.
6. Run focused tests, Effect migration checks, the complete repository check,
   executable access conformance, and the disposable Fleet recovery runbook.
