# First Mate access-profile control plane

Status: released v1 control contract for AgentOS issue #89.

First Mate can publish reusable access profiles and bind one immutable version to one live Mate or Assignment, but cannot administer OpenFGA directly and cannot widen the current Captain ceiling. The public TypeScript surface is Effect-native and inert at import. The durable authority is the SQL-first `0018_access_control_plane.sql` migration.

## Authority split

- Captain/platform publishes one finite, immutable, contiguous ceiling revision.
- First Mate publishes immutable profile versions with an expected previous version, then explicitly binds an exact version. Publishing v2 never silently changes a v1 binding.
- PostgreSQL owns profile heads, bindings, repair-forward operation phase, optimistic concurrency, and append-only audit.
- The core access executor owns OpenFGA tuple mutation and higher-consistency verification. It may mount the OpenFGA administrative key; the First Mate workload and Agent namespaces may not. Its mandatory `AccessControlOperationGuard` reloads the durable ceiling/profile/binding state, recompiles through the canonical functions, and requires exact subject/stage equality before any OpenFGA call. A merely schema-valid caller-supplied plan is never trusted.
- The workload-identity cache owns its positive entries. The executor invalidates the affected immutable subject before acknowledging a completed binding mutation.

The released profile reload SLO is 15 seconds. A committed profile version is immediately visible in PostgreSQL and emits the `agentos_access_control` wake hint; an API process must refresh within that bound. The revocation SLO is 60 seconds, aligned with the workload-identity deletion boundary. A binding create, revoke, or ceiling shrink is not acknowledged merely because its tuple write returned: every affected `allow_<capability>` relation must first return its expected decision with `HIGHER_CONSISTENCY`.

One subject has at most one pending or active v1 binding. A profile is therefore the subject's finite composite provider-access policy, which prevents two independent bindings from racing over the same direct OpenFGA grant tuple. Replacing that policy is an explicit revoke-then-bind operation; profile publication alone never changes a live subject.

## Publication and binding

`publishAccessProfileVersion` decodes the current ceiling and prior profile with closed Effect Schema contracts. It requires the caller's expected version to equal the durable profile head. Every requested capability, canonical resource, environment, rate class, and expiry must fit one exact ceiling permission. The SQL function repeats those bounds while holding the profile head lock, inserts the next immutable version, advances the head, appends one completed operation and audit record, and returns the same result for an exact operation-ID retry.

Binding uses a repair-forward operation:

1. Compile the before/after ceiling, profile, and binding states into exact OpenFGA tuple plans.
2. Begin one SQL operation with a caller-selected UUID, request digest, one or two closed tuple/check stages, actor, target, old/new profile version, finite reason, and correlation ID. A new binding remains `pending`; a revoked binding remains `active`.
3. The core guard recompiles the canonical plan from freshly loaded durable state and rejects any mismatch before external mutation. The executor then applies each mutation idempotently, strongly checks the stage, and durably advances the exact stage index. If an existing tuple key needs a new active-window condition, stage one deletes it and observes deny before stage two writes and verifies the replacement. The temporary window is fail-closed.
4. Mark the operation `verified`, invalidate the exact Mate or Assignment identity cache key, and complete it in one short SQL transaction. Only completion activates or revokes the binding and appends audit.

If the process stops after any external boundary, the same operation ID reloads its durable phase and next stage. A `prepared` retry may safely repeat only that idempotent stage; OpenFGA uses duplicate/missing conflict-ignore behavior. A `verified` retry skips OpenFGA and resumes invalidation/completion. A conflicting digest, target, or expected stage fails closed. Operation identity, immutable profile rows, phase events, and audit rows cannot be updated or deleted.

## Ceiling shrink

A later Captain ceiling revision is inserted as `pending` whenever the ceiling still has active subjects. `prepareAccessCeilingReconciliation` compiles the old and new ceiling across the complete active-subject set. PostgreSQL rejects a partial subject set and serializes overlapping binding changes. The executor then performs the same staged, higher-consistency reconciliation and invalidates every subject. Only the final completion transaction supersedes the former ceiling and promotes the pending revision. Until that point PostgreSQL continues to report the former revision as current, so an interrupted or failed shrink is never acknowledged as active. If the ceiling has no active bindings, the new immutable revision can be activated immediately because no external grant exists to reconcile.

## Inspection and privacy

`effectiveAccessForBinding` evaluates every profile permission against the current ceiling, exact subject, binding state, rate and active windows, returning only current allow decisions. It does not treat the binding's issued-under ceiling revision as continuing authority.

Registered Agents retain the Fleet-wide read view used elsewhere in AgentOS. Only First Mate receives profile/binding mutation functions; Second Mates and Crewmates cannot invoke them or directly modify the tables. The journal accepts only closed OpenFGA tuple/check objects. Audit stores actor Agent and ServiceAccount UIDs, target, old/new version, finite reason, recorded/denied decision, correlation ID, and time. Credentials, authorization headers, provider payloads, prompts, response bodies, arbitrary metadata, and arbitrary error text have no column or accepted plan field.

The generated OpenFGA model and runtime contract remain in [`openfga-authorization.md`](./openfga-authorization.md). Provider credentials stay outside this control plane.
