# Provider access capability and ceiling model

Status: released v1 contract for AgentOS issue #88.

## Authority and evaluation

Captain/platform owns the finite capability registry and publishes immutable, contiguous ceiling revisions for one exact Fleet or Second-Mate domain. First Mate may publish immutable profile versions and bind one exact version to one Mate or Assignment only through the later control-plane implementation. First Mate cannot add a capability, reinterpret an action, change a resource kind, or widen the supplied Captain ceiling.

Every request-time decision uses the current Captain ceiling. The ceiling revision recorded on a binding is provenance, not continuing authority. If revision 2 removes or tightens a permission issued under revision 1, the old profile and binding immediately evaluate as denied. Expiry and rate-class limits also compose by taking the stricter current value.

The v1 contract deliberately is not a policy language. One permission contains only:

- one enumerated capability and action;
- one exact provider service/account/adapter, GitHub repository, or GitHub project;
- one exact optional environment;
- one optional absolute expiry; and
- one finite rate class.

There are no wildcard capabilities or resources, URL/path expressions, CEL fragments, arbitrary conditions, embedded provider requests, or free-form audit metadata. New actions require a reviewed repository release of the registry and OpenFGA model rather than a runtime string.

## Canonical names

Subjects keep organizational custody separate from provider targets:

- `fleet:<fleet>`;
- `fleet:<fleet>/domain:<domain>`;
- `fleet:<fleet>/domain:<domain>/mate:<immutable-agent-uuid>`; and
- `fleet:<fleet>/domain:<domain>/assignment:<immutable-assignment-uuid>`.

Resources are similarly exact:

- `provider:<provider>/service:<service>`;
- `provider:<provider>/account:<opaque-account-ref>`;
- `provider:<provider>/adapter:<adapter>`;
- `github:repository:<owner>/<repository>`; and
- `github:project:<organization>/<project-number>`.

The canonical strings are transport names for a validated typed value. Callers do not pass an unparsed canonical string into authorization.

## Threat-model review

### Confused deputy

Risk: a Mate asks the provider adapter to exercise a valid capability for another Mate, Assignment, repository, or environment.

Controls: the authorizer derives the subject from the reviewed Kubernetes identity rather than a caller header; the binding subject must exactly equal that derived subject; the permission names one exact resource and environment; and the provider adapter receives the normalized allowed tuple rather than interpreting an Agent-supplied provider request as policy. Assignment-scoped operations require the active immutable Assignment identity in #87/#90.

### Impersonation

Risk: two Pods share a mutable ServiceAccount name or a stale token and claim the same Mate.

Controls: subject names use immutable Agent/Assignment UUIDs. #87 additionally binds the request to the dedicated token audience, ServiceAccount UID, bound Pod UID, namespace, live Pod ownership, active Mate, and active Assignment. The access contract never treats display names, headers, or profile IDs as authentication.

### Stale identity and stale policy

Risk: a deleted Pod, ended Assignment, revoked binding, expired permission, or replaced ceiling continues to authorize through a cache or recorded revision.

Controls: identity validity and positive-cache TTL are owned by #87; bindings have explicit active/revoked state and expiry; permissions have absolute expiry; profiles bind an exact immutable version; and evaluation always receives the current ceiling. Security-sensitive mutations in #89/#90 require higher-consistency verification before acknowledgement and must invalidate positive caches inside the revocation SLO.

### Privilege escalation

Risk: First Mate invents a generic capability, targets provider root scope, raises a rate class, extends expiry, or smuggles provider-specific request matching into policy.

Controls: Effect Schema rejects unknown and excess fields; the registry is finite and Captain-owned; each capability enumerates its allowed resource kinds; resource identifiers reject wildcards; permission duplicates are ambiguous and rejected; profile versions form one contiguous immutable chain; and rate/expiry evaluation is bounded by the current ceiling. First Mate never receives OpenFGA administration or provider credentials.

### Replay

Risk: an old mutation, binding, token, or provider side effect is replayed after authority changes.

Controls: ceiling/profile revisions and binding/audit identifiers are immutable; bindings name one exact profile version and issued-under revision; current-ceiling evaluation defeats replay of wider old authority; expiries bound time; #87 supplies short-lived audience-bound workload tokens; and #89 journals idempotent mutations with optimistic concurrency and higher-consistency verification. Provider-side non-idempotent actions still require their native idempotency/precondition mechanism—gateway retries are not treated as replay protection.

## Privacy boundary

Ceiling, profile, binding, decision, and audit schemas have closed fields. They can contain identity references, canonical capabilities/resources, versions, finite reasons, correlation IDs, timestamps, expiry, environment, and rate class. They cannot contain credentials, authorization headers, prompts, request/response bodies, provider payloads, arbitrary error text, or arbitrary metadata. Decode errors expose only a safe contract boundary and field path.

## Follow-on ownership

- #87 derives and validates workload identity.
- #90 implements these exact subjects, resources, and capabilities in the immutable `agentos-access-v1` OpenFGA model and its tuple compiler.
- #89 owns profile mutation, optimistic concurrency, current-ceiling validation, audit persistence, cache invalidation, and reconciliation.
- #95 owns provider-scoped credential delivery; policy records never become a secret store.
- #107 defines rate-class budgets and kill-switch behavior without widening the v1 capability language.
