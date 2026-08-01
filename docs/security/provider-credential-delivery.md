# Provider-isolated credential delivery

AgentOS delivers an upstream credential only inside the provider component that forwards an already authenticated and authorized request. A Mate receives neither the upstream credential nor a credential-returning API. The authorizer and OpenFGA receive only identity, capability, canonical resource, environment, rate class, decision reference, and correlation fields.

The released Effect contract is [`credential-delivery.ts`](../../packages/agentos/src/access/credential-delivery.ts). It defines three separate services:

- `ProviderPolicyEnforcementPoint` authenticates the Pod-bound ServiceAccount token and refuses to forward a denial.
- `ProviderPolicyDecisionPoint` asks the strongly consistent authorization boundary for a bounded decision reference. Its request and result Schemas have no credential field.
- `ProviderCredentialDeliveryPoint` accepts an opaque request handle plus an allowed decision reference, attaches one domain credential internally, forwards once, drops request-scoped credential material, and returns only a bounded receipt or typed provider-route outcome.

`compileProviderCredentialPlan` decodes closed input, requires the capability and resource provider to agree, rejects duplicate upstream hosts, and emits one adapter ServiceAccount, one credential domain, one route-host set, and zero or one Secret projection. Secret-backed plans accept only namespace `agentos`; `agentos-domain-*` is rejected. A process that serves one compiled plan therefore has no contract or mount through which it can read another domain's credential. Production network and workload enforcement of the emitted isolation plan belongs to the owned manifests in #96.

## Strategy selection

| Upstream authentication | Delivery component | Root material | Rotation behavior |
| --- | --- | --- | --- |
| Static header/API key | One read-only agentgateway instance for that credential domain | One file-projected Secret | Resource-version-guarded Secret replace, then roll only the two-replica adapter |
| RFC 8693/RFC 7523 exchange | Native agentgateway backend auth, only when the upstream supports the declared grant and subject-token chain | One file-projected OAuth client Secret when required | Roll only the provider adapter after Secret replacement; exchanged tokens stay provider-local |
| AWS request signing | Native agentgateway workload identity | No Kubernetes Secret | Refresh the provider identity session before its bounded expiry |
| GCP authentication | Native agentgateway workload identity | No Kubernetes Secret | Refresh the provider identity session before its bounded expiry |
| GitHub App | GitHub-only broker | One GitHub App Secret mounted only into that broker | Replace and roll the GitHub broker; installation tokens never return to a Mate |
| Refresh token | Provider-only broker, including the Fleet AI Gateway | One refresh-token Secret mounted only into that broker | Replace and roll that broker; access tokens remain internal |
| Unsupported native client | No fallback | None | Fail with `provider_broker_required` until a reviewed provider adapter exists |

Agentgateway-native OAuth exchange is not a generic promise that any CLI can use OAuth through a proxy. It is selected only when the provider accepts the relevant exchange or assertion and the incoming identity chain can produce the required subject token. A client that cannot select the governed base URL needs a reviewed provider broker; AgentOS does not hand a short-lived bearer token back to the client as a compatibility escape.

The pinned agentgateway v1.4.1 source accepts `{ file: ... }` for static keys and OAuth client secrets, trims the file, and loads it into redacted memory while parsing configuration. It does not reread the projected file on every request. AgentOS therefore does not claim that a Kubernetes projected-Secret update hot-reloads a credential. The safe operation is a zero-downtime rolling restart of only the affected two-replica adapter (`maxUnavailable: 0`) after the guarded Secret replacement. Agent Pods are never restarted.

The reviewed Helm input in [`services/agentgateway/kubernetes/values.yaml`](../../services/agentgateway/kubernetes/values.yaml) demonstrates the first domain. `agentgateway-openai` mounts only `Secret/agentgateway-ai-gateway-client`, read-only at `/var/run/secrets/agentos-provider/openai/credential`, with mode `0440` through `fsGroup: 2000`. Backend auth stores the file path, not the token, in the ConfigMap. The Service remains private and external authorization remains fail closed. Kustomize remains the production authority; the Helm input is the pinned upstream render comparison for #96.

## Rotation and recovery

Use the managed Secret procedure released in #80: create on absence, replace only with the current `resourceVersion`, keep UID stable, use the exact ownership labels and data keys, reject takeover, never write a last-applied annotation, and keep credential bytes out of command output and artifacts. After a successful replacement:

1. mark the provider domain as rotating with the new desired Secret resource version;
2. roll only that provider adapter and keep the previous replica serving while a new replica proves readiness;
3. observe the new resource version loaded by every serving replica;
4. retire the previous replica before the 60-second stale-credential deadline;
5. if readiness fails, return `credential_rejected` or `credential_unavailable` only on that provider route, restore the previous Secret revision, and roll that adapter again.

`resolveProviderCredentialRouteState` is the deterministic enforcement contract. A matching resource version is `credential_ready`. A mismatched version before the deadline is `credential_rotating`. At the 60-second boundary it becomes `credential_unavailable`; stale material is no longer eligible to serve. Missing, rejected, and exchange failures map to finite outcomes without arbitrary provider text. A state transition is evaluated for one exact provider and credential domain, so it cannot make an unrelated domain unavailable.

Cloud workload identity uses its provider-session expiry rather than a Kubernetes Secret resource version. The delivery plan emits no Secret mount and requires session refresh before its bounded expiry. Recovery rebinds the previous reviewed workload identity; it never introduces a root credential Secret into a Mate namespace.

## Data minimization

The public plan, decision, route-state, failure, and receipt Schemas contain references and finite outcomes only. They deliberately exclude provider tokens, authorization values, client secrets, refresh tokens, private keys, credential payloads, upstream bodies, arbitrary error messages, and arbitrary metadata. Unknown fields fail decoding. These same closed shapes are the only permitted journal, event, log, trace, and persisted-configuration representation for the credential-delivery control plane.

The four provider failure outcomes are `credential_unavailable`, `credential_rejected`, `credential_rotating`, and `credential_exchange_failed`. They carry provider, credential domain, retryability, and correlation ID. Provider response bodies and secrets remain outside telemetry. The eventual HTTP/gRPC adapter maps these finite outcomes to the stable gateway envelope without placing credential material in a response.

## External references

- [Agentgateway backend authentication](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/)
- [Agentgateway OAuth token exchange](https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/oauth-token-exchange/)
- [Agentgateway external authorization](https://agentgateway.dev/docs/standalone/latest/configuration/security/external-authz/)
- [Agent credential-injection architecture](https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/)
