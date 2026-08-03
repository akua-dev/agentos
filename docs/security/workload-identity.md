# Kubernetes workload identity for provider egress

Status: released v1 contract for AgentOS issue #87.

## Trust chain

AgentOS workloads receive a second, explicit projected ServiceAccount token for provider-egress authentication. Its contract is fixed:

- audience: `agentos-egress-authz`;
- path: `/var/run/secrets/agentos-egress/token`;
- requested lifetime: 600 seconds; and
- volume and mount: `agentos-egress-identity`, read-only with mode `0440`.

This is not the workload's Kubernetes API token. Persistent Second Mates retain their separately managed Kubernetes supervision identity. Crewmates keep `automountServiceAccountToken: false` and receive only the explicit audience-scoped projection. Only the long-running Agent container mounts this token; tool-install and home-preparation init containers do not, and domain admission rejects any Crewmate init-container mount. The kubelet rotates projected tokens, so clients must read the token file for each request rather than retaining its contents for the process lifetime.

The authorization service built by #90 supplies the raw token only to `KubernetesTokenReviewer`. It requests exactly the dedicated audience and accepts a result only when `authenticated` is true and the same audience appears in `status.audiences`. Kubernetes documents that a TokenReview client setting audiences must check the returned intersection; accepting an empty result would fall back to API-server audience semantics and is forbidden here. See the Kubernetes [TokenReview API](https://kubernetes.io/docs/reference/kubernetes-api/definitions/token-review-v1-authentication/).

The reviewed username must be exactly `system:serviceaccount:<namespace>:<name>`. The ServiceAccount UID, one Pod name, and one Pod UID must be present. AgentOS then reads the current Pod and ServiceAccount and requires:

- exact namespace, names, and UIDs;
- no deletion timestamp;
- a `Running` Pod whose `spec.serviceAccountName` is the reviewed ServiceAccount; and
- one exact AgentOS Agent row located by that namespace and Pod name.

This online check is deliberate. Kubernetes states that offline JWT validation does not establish whether a bound object still exists and that clients needing current bound-claim assurance must use TokenReview. Kubernetes also invalidates a bound token when its Pod or ServiceAccount disappears or its UID changes, subject to a deletion grace interval. See [Managing Service Accounts: bound tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/#bound-service-account-tokens).

The Agent row must have `lifecycle_status = 'active'` and no `retired_at`. When the requested provider operation requires Assignment scope, the identity store—not the caller—must derive exactly one Assignment for that Agent with `status = 'active'` and no `ended_at`. The normalized output is the only identity accepted by later capability/OpenFGA evaluation; Agent IDs, Assignment IDs, ServiceAccount names, Pod names, labels, and HTTP headers supplied by a caller are never authentication on their own.

The released PostgreSQL adapter uses the dedicated `agentos_egress_authz`
service login and only the three `0019_egress_authorizer_reads.sql` Functions.
It has no direct table access and is not a registered Agent principal. An Agent
locator becomes provider identity only when an exact current access binding
also supplies one unambiguous Fleet/domain scope. This deliberately fails
closed when the same workload could resolve through inconsistent scopes; it
does not infer authority from namespace naming.

Policy lookup is one statement-consistent binding/profile/head/ceiling
snapshot. Closed Effect Schemas decode the result, and the adapter rejects a
missing or duplicate binding, pending/expired binding, stale profile head,
mismatched ceiling reference, pending ceiling reconciliation, inactive or
future ceiling, or in-progress access-control operation. Therefore a rollout
is never acknowledged from a mixture of database versions.

## Cache and revocation

Only successful normalized identities are cached. The key is a SHA-256 digest of the bearer token plus whether active Assignment identity was required. Neither raw token nor JWT payload is retained. A cache entry expires at the earlier of:

- the verified token's `exp` claim; or
- 15 seconds after online validation.

The JWT payload is decoded only after TokenReview succeeds and only to shorten cache validity; its contents never establish authenticity. Authentication, lookup, ambiguity, lifecycle, and dependency failures are never cached.

The published revocation SLO is 60 seconds, matching Kubernetes' documented
upper deletion grace for bound ServiceAccount-token authentication. AgentOS'
15-second positive TTL stays inside that limit. Control-plane operations that
delete/recreate a Pod or ServiceAccount, retire an Agent, end an Assignment, or
change an identity binding must additionally call the authenticator's explicit
Pod UID, ServiceAccount UID, Agent ID, Assignment ID, or global invalidation
operation before acknowledging the mutation. The released #89 control plane
performs invalidation before it acknowledges a profile/binding mutation; the
#92 hard gate independently proves bound-object deletion and replacement
against a real API server.

## Failure taxonomy

The access boundary uses separate closed tagged errors:

- `WorkloadAuthenticationError`: malformed/expired/rejected token, audience or bound-object failure, deleted/missing Kubernetes identity, UID/ownership mismatch, or non-running Pod;
- `WorkloadIdentityResolutionError`: missing, ambiguous, inactive, or locator-mismatched Agent/Assignment;
- `WorkloadAuthorizationError`: an authenticated identity cannot own the derived authorization subject;
- `WorkloadIdentityDependencyUnavailable`: TokenReview, Kubernetes lookup, or AgentOS identity-store availability/response failure; and
- `WorkloadPolicyDenied`: a later current-policy decision denied an otherwise authenticated identity.

Every category fails closed before provider credentials are available. Dependency error fields contain only a finite dependency and operation code—never upstream error text. The authenticator emits no log records or metrics. Its span contains only the fixed audience, cache-hit state, Assignment-required state, Agent ID, and namespace; bearer tokens, JWT payloads, request/response bodies, prompts, credentials, and provider payloads are excluded.

## Impersonation boundary

Two Pods using the same ServiceAccount still receive different Pod-bound tokens. The reviewed Pod name/UID must resolve to the exact active Agent locator, so a second Pod's own token cannot inherit the first Pod's Agent identity. Recreating a Pod under the same name changes its UID and invalidates the old token path.

The projected token remains a bearer credential: a process that exfiltrates another live Pod's complete token can replay it until online revocation or expiry. TokenReview cannot prove which network process presented a copied bearer token. AgentOS therefore keeps the file read-only and Pod-local, excludes it from telemetry and persistence, uses the minimum projection lifetime, and does not expose provider credentials to the workload. Proof-of-possession would require a separately reviewed mTLS/SPIFFE-style design and is not implied by this contract.

Kubernetes requires projected ServiceAccount token lifetimes to be at least 600 seconds and refreshes the projection before expiry. See [Projected volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/#serviceaccounttoken-projected-volumes).
