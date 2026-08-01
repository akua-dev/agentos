# OpenFGA authorization boundary

Status: released `agentos-access-v1` implementation for AgentOS issue #90.

AgentOS translates the finite provider-access contracts from [`provider-access-capability-model.md`](./provider-access-capability-model.md) into one immutable OpenFGA model. It does not turn OpenFGA into a policy scripting surface and does not store provider credentials there.

For each released capability the model declares three explicit relations on an exact `authorization_target`:

- `profile_<capability>` points to one immutable access-profile version;
- `ceiling_<capability>` points to one immutable Captain ceiling revision; and
- `allow_<capability>` is the exact, time-bounded Mate or Assignment grant produced by the typed policy compiler.

Fleet membership inherits a Mate or Assignment through its exact domain. Profile bindings carry an active-window condition. Profile and ceiling permission tuples carry their own active windows. The compiler materializes an `allow_<capability>` tuple only when the subject is in the ceiling scope, the binding is active, profile and ceiling contain the same capability/resource/environment, neither rate class is disabled, and the profile rate class does not exceed the Captain ceiling. Its effective time is the later of binding creation and ceiling activation; its expiry is the earliest binding, profile, or ceiling expiry. Disabled permissions, over-ceiling rates, and revoked bindings emit no granting tuple. Targets encode Fleet, canonical provider resource, and environment; there are no wildcard subjects, relations, targets, URLs, or provider payloads.

The tuple compiler decodes every ceiling, profile, and binding with closed Effect Schema contracts. It rejects mismatched profile versions, ceiling IDs, future issued-under revisions, out-of-scope subjects, invalid timestamps, and non-atomic condition replacement. Ceiling shrink changes the immutable ceiling object and deletes grants no longer present in the fully intersected result. Binding revocation deletes both the profile-subject path and all materialized grants. OpenFGA remains the immutable authorization store and strongly checked decision point; materializing the finite intersection avoids a runtime graph branch that can stall on the PostgreSQL datastore while preserving auditable profile, ceiling, Fleet, and final-grant tuples.

The OpenFGA HTTP boundary is Effect-native, bounded, interruptible, timeout-controlled, schema-decoded, and credential-redacted. It never includes a preshared key or upstream response body in its errors. Store/model IDs are ULIDs. Every request pins both IDs. Security-sensitive tuple acknowledgement and semantic readiness always request `HIGHER_CONSISTENCY`.

The runtime and operational contract live in [`services/openfga/README.md`](../../services/openfga/README.md). That topology keeps the administrative key out of all Mate namespaces, uses a dedicated OpenFGA database rather than AgentOS workflow tables, and keeps ordinary Agent Internet egress unchanged.
