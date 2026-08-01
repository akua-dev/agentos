# OpenFGA authorization boundary

Status: released `agentos-access-v1` implementation for AgentOS issue #90.

AgentOS translates the finite provider-access contracts from [`provider-access-capability-model.md`](./provider-access-capability-model.md) into one immutable OpenFGA model. It does not turn OpenFGA into a policy scripting surface and does not store provider credentials there.

For each released capability the model declares three explicit relations on an exact `authorization_target`:

- `profile_<capability>` points to one immutable access-profile version;
- `ceiling_<capability>` points to one immutable Captain ceiling revision; and
- `allow_<capability>` intersects target Fleet membership with both subjects.

Fleet membership inherits a Mate or Assignment through its exact domain. Profile bindings carry an active-window condition. Profile and ceiling permission tuples carry their own active windows. Disabled permissions and revoked bindings emit no granting tuple. Targets encode Fleet, canonical provider resource, and environment; there are no wildcard subjects, relations, targets, URLs, or provider payloads.

The tuple compiler decodes every ceiling, profile, and binding with closed Effect Schema contracts. It rejects mismatched profile versions, ceiling IDs, future issued-under revisions, out-of-scope subjects, invalid timestamps, and non-atomic condition replacement. Ceiling shrink changes the immutable ceiling object and atomically deletes the prior relation path. Binding revocation deletes the profile-subject path.

The OpenFGA HTTP boundary is Effect-native, bounded, interruptible, timeout-controlled, schema-decoded, and credential-redacted. It never includes a preshared key or upstream response body in its errors. Store/model IDs are ULIDs. Every request pins both IDs. Security-sensitive tuple acknowledgement and semantic readiness always request `HIGHER_CONSISTENCY`.

The runtime and operational contract live in [`services/openfga/README.md`](../../services/openfga/README.md). That topology keeps the administrative key out of all Mate namespaces, uses a dedicated OpenFGA database rather than AgentOS workflow tables, and keeps ordinary Agent Internet egress unchanged.
