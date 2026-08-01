import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AccessBindingSubjectV1Schema,
  AccessCeilingRefV1Schema,
  AccessCeilingScopeV1Schema,
  AccessPermissionV1Schema,
  AccessProfileRefV1Schema,
  type AccessBindingSubjectV1,
} from "./contracts.ts";
import {
  AgentOSWorkloadAgentV1Schema,
  AgentOSWorkloadAssignmentV1Schema,
  AgentOSWorkloadIdentityStore,
  WorkloadIdentityDependencyUnavailable,
  type AgentOSWorkloadReference,
} from "./identity.ts";

const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const PositiveInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);

export class ProviderAccessDatabaseUnavailable extends Schema.TaggedErrorClass<ProviderAccessDatabaseUnavailable>()(
  "ProviderAccessDatabaseUnavailable",
  {
    operation: Schema.Literals([
      "find_workload_agents",
      "find_assignments",
      "find_policy_snapshots",
    ]),
  },
) {}

export class ProviderAccessDatabase extends Context.Service<
  ProviderAccessDatabase,
  {
    readonly findWorkloadAgents: (
      reference: AgentOSWorkloadReference,
    ) => Effect.Effect<
      ReadonlyArray<unknown>,
      ProviderAccessDatabaseUnavailable
    >;
    readonly findAssignments: (
      agentId: string,
    ) => Effect.Effect<
      ReadonlyArray<unknown>,
      ProviderAccessDatabaseUnavailable
    >;
    readonly findPolicySnapshots: (
      subject: AccessBindingSubjectV1,
    ) => Effect.Effect<
      ReadonlyArray<unknown>,
      ProviderAccessDatabaseUnavailable
    >;
  }
>()("agentos/access/ProviderAccessDatabase") {}

function databaseUnavailable(
  operation: ProviderAccessDatabaseUnavailable["operation"],
) {
  return ProviderAccessDatabaseUnavailable.make({ operation });
}

export const ProviderAccessDatabaseSqlLayer = Layer.effect(
  ProviderAccessDatabase,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return ProviderAccessDatabase.of({
      findWorkloadAgents: (reference) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.read_egress_workload_agents(
            ${reference.kubernetesNamespace}, ${reference.kubernetesPod}
          )
        `.pipe(
          Effect.mapError(() => databaseUnavailable("find_workload_agents")),
        ),
      findAssignments: (agentId) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.read_egress_assignments(${agentId}::uuid)
        `.pipe(
          Effect.mapError(() => databaseUnavailable("find_assignments")),
        ),
      findPolicySnapshots: (subject) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.read_egress_policy_snapshots(
            ${JSON.stringify(subject)}::jsonb
          )
        `.pipe(
          Effect.mapError(() => databaseUnavailable("find_policy_snapshots")),
        ),
    });
  }),
);

const decodeWorkloadAgents = Schema.decodeUnknownEffect(
  Schema.Array(AgentOSWorkloadAgentV1Schema),
);
const decodeAssignments = Schema.decodeUnknownEffect(
  Schema.Array(AgentOSWorkloadAssignmentV1Schema),
);

function workloadDatabaseError(
  operation: "find_agent" | "find_assignment",
) {
  return WorkloadIdentityDependencyUnavailable.make({
    dependency: "identity_store",
    operation,
    code: "database_unavailable",
  });
}

function workloadResponseError(
  operation: "find_agent" | "find_assignment",
) {
  return WorkloadIdentityDependencyUnavailable.make({
    dependency: "identity_store",
    operation,
    code: "invalid_response",
  });
}

export const AgentOSWorkloadIdentityStorePostgresLayer = Layer.effect(
  AgentOSWorkloadIdentityStore,
  Effect.gen(function*() {
    const database = yield* ProviderAccessDatabase;
    return AgentOSWorkloadIdentityStore.of({
      findAgentsByWorkload: (reference) =>
        database.findWorkloadAgents(reference).pipe(
          Effect.mapError(() => workloadDatabaseError("find_agent")),
          Effect.flatMap((rows) =>
            decodeWorkloadAgents(rows).pipe(
              Effect.mapError(() => workloadResponseError("find_agent")),
            )
          ),
        ),
      findAssignmentsByAgent: (agentId) =>
        database.findAssignments(agentId).pipe(
          Effect.mapError(() => workloadDatabaseError("find_assignment")),
          Effect.flatMap((rows) =>
            decodeAssignments(rows).pipe(
              Effect.mapError(() => workloadResponseError("find_assignment")),
            )
          ),
        ),
    });
  }),
);

const RawProviderPolicySnapshotRowSchema = Schema.Struct({
  bindingId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^binding_[0-9a-f]{32}$/)),
  ),
  bindingSubject: AccessBindingSubjectV1Schema,
  bindingCreatedAtMillis: EpochMillis,
  bindingExpiresAtMillis: Schema.NullOr(EpochMillis),
  bindingState: Schema.Literals(["pending", "active"]),
  profileId: AccessProfileRefV1Schema.fields.profileId,
  profileVersion: PositiveInt,
  previousProfileVersion: Schema.NullOr(PositiveInt),
  profileTargetScope: AccessCeilingScopeV1Schema,
  profilePermissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
  profileCeilingId: AccessCeilingRefV1Schema.fields.ceilingId,
  profileCeilingRevision: PositiveInt,
  profileHeadVersion: Schema.NullOr(PositiveInt),
  bindingCeilingId: AccessCeilingRefV1Schema.fields.ceilingId,
  bindingCeilingRevision: PositiveInt,
  ceilingScope: AccessCeilingScopeV1Schema,
  ceilingEffectiveAtMillis: EpochMillis,
  ceilingPermissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
  ceilingState: Schema.Literals(["pending", "active", "superseded"]),
  pendingCeilingRevision: Schema.NullOr(PositiveInt),
  operationInProgress: Schema.Boolean,
});

export const ProviderPolicySnapshotV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  binding: Schema.Struct({
    bindingId: RawProviderPolicySnapshotRowSchema.fields.bindingId,
    subject: AccessBindingSubjectV1Schema,
    createdAtMillis: EpochMillis,
    expiresAtMillis: Schema.NullOr(EpochMillis),
  }),
  profile: Schema.Struct({
    profileId: AccessProfileRefV1Schema.fields.profileId,
    profileVersion: PositiveInt,
    previousProfileVersion: Schema.NullOr(PositiveInt),
    targetScope: AccessCeilingScopeV1Schema,
    permissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
    issuedUnderCeiling: AccessCeilingRefV1Schema,
  }),
  ceiling: Schema.Struct({
    ceilingId: AccessCeilingRefV1Schema.fields.ceilingId,
    revision: PositiveInt,
    scope: AccessCeilingScopeV1Schema,
    effectiveAtMillis: EpochMillis,
    permissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
  }),
});

export type ProviderPolicySnapshotV1 =
  typeof ProviderPolicySnapshotV1Schema.Type;

const ProviderPolicySnapshotUnavailableCode = Schema.Literals([
  "database_unavailable",
  "invalid_response",
  "binding_not_found",
  "binding_ambiguous",
  "binding_pending",
  "binding_expired",
  "binding_not_effective",
  "subject_mismatch",
  "profile_stale",
  "reference_mismatch",
  "ceiling_reconciliation_pending",
  "ceiling_inactive",
  "ceiling_not_effective",
  "operation_unreconciled",
]);

export class ProviderPolicySnapshotUnavailable extends Schema.TaggedErrorClass<ProviderPolicySnapshotUnavailable>()(
  "ProviderPolicySnapshotUnavailable",
  {
    dependency: Schema.Literal("postgresql"),
    operation: Schema.Literal("find_policy_snapshot"),
    code: ProviderPolicySnapshotUnavailableCode,
  },
) {}

export class ProviderPolicySnapshotStore extends Context.Service<
  ProviderPolicySnapshotStore,
  {
    readonly findBySubject: (
      subject: AccessBindingSubjectV1,
    ) => Effect.Effect<
      ProviderPolicySnapshotV1,
      ProviderPolicySnapshotUnavailable
    >;
  }
>()("agentos/access/ProviderPolicySnapshotStore") {}

function snapshotUnavailable(
  code: ProviderPolicySnapshotUnavailable["code"],
) {
  return ProviderPolicySnapshotUnavailable.make({
    dependency: "postgresql",
    operation: "find_policy_snapshot",
    code,
  });
}

const decodePolicySnapshotRows = Schema.decodeUnknownEffect(
  Schema.Array(RawProviderPolicySnapshotRowSchema),
);

export const ProviderPolicySnapshotStorePostgresLayer = Layer.effect(
  ProviderPolicySnapshotStore,
  Effect.gen(function*() {
    const database = yield* ProviderAccessDatabase;
    return ProviderPolicySnapshotStore.of({
      findBySubject: Effect.fn("ProviderPolicySnapshotStore.findBySubject")(
        function*(subject: AccessBindingSubjectV1) {
          const rawRows = yield* database.findPolicySnapshots(subject).pipe(
            Effect.mapError(() => snapshotUnavailable("database_unavailable")),
          );
          const rows = yield* decodePolicySnapshotRows(rawRows).pipe(
            Effect.mapError(() => snapshotUnavailable("invalid_response")),
          );
          if (rows.length === 0) {
            return yield* snapshotUnavailable("binding_not_found");
          }
          if (rows.length !== 1) {
            return yield* snapshotUnavailable("binding_ambiguous");
          }
          const row = rows[0]!;
          const now = yield* Clock.currentTimeMillis;
          if (row.bindingState !== "active") {
            return yield* snapshotUnavailable("binding_pending");
          }
          if (
            row.bindingExpiresAtMillis !== null &&
            row.bindingExpiresAtMillis <= now
          ) {
            return yield* snapshotUnavailable("binding_expired");
          }
          if (row.bindingCreatedAtMillis > now) {
            return yield* snapshotUnavailable("binding_not_effective");
          }
          if (!sameSubject(row.bindingSubject, subject)) {
            return yield* snapshotUnavailable("subject_mismatch");
          }
          if (row.profileHeadVersion !== row.profileVersion) {
            return yield* snapshotUnavailable("profile_stale");
          }
          if (
            row.profileCeilingId !== row.bindingCeilingId ||
            row.profileCeilingRevision !== row.bindingCeilingRevision ||
            !sameScope(row.profileTargetScope, row.ceilingScope) ||
            !scopeContainsSubject(row.ceilingScope, row.bindingSubject)
          ) {
            return yield* snapshotUnavailable("reference_mismatch");
          }
          if (row.pendingCeilingRevision !== null) {
            return yield* snapshotUnavailable(
              "ceiling_reconciliation_pending",
            );
          }
          if (row.ceilingState !== "active") {
            return yield* snapshotUnavailable("ceiling_inactive");
          }
          if (row.ceilingEffectiveAtMillis > now) {
            return yield* snapshotUnavailable("ceiling_not_effective");
          }
          if (row.operationInProgress) {
            return yield* snapshotUnavailable("operation_unreconciled");
          }
          return {
            schemaVersion: 1,
            binding: {
              bindingId: row.bindingId,
              subject: row.bindingSubject,
              createdAtMillis: row.bindingCreatedAtMillis,
              expiresAtMillis: row.bindingExpiresAtMillis,
            },
            profile: {
              profileId: row.profileId,
              profileVersion: row.profileVersion,
              previousProfileVersion: row.previousProfileVersion,
              targetScope: row.profileTargetScope,
              permissions: row.profilePermissions,
              issuedUnderCeiling: {
                ceilingId: row.profileCeilingId,
                revision: row.profileCeilingRevision,
              },
            },
            ceiling: {
              ceilingId: row.bindingCeilingId,
              revision: row.bindingCeilingRevision,
              scope: row.ceilingScope,
              effectiveAtMillis: row.ceilingEffectiveAtMillis,
              permissions: row.ceilingPermissions,
            },
          } satisfies ProviderPolicySnapshotV1;
        },
      ),
    });
  }),
);

function sameSubject(
  left: AccessBindingSubjectV1,
  right: AccessBindingSubjectV1,
) {
  if (left.kind !== right.kind) return false;
  if (left.fleet !== right.fleet || left.domain !== right.domain) return false;
  return left.kind === "mate" && right.kind === "mate"
    ? left.agentId === right.agentId
    : left.kind === "assignment" && right.kind === "assignment" &&
      left.assignmentId === right.assignmentId;
}

function sameScope(
  left: typeof AccessCeilingScopeV1Schema.Type,
  right: typeof AccessCeilingScopeV1Schema.Type,
) {
  if (left.kind !== right.kind || left.fleet !== right.fleet) return false;
  return left.kind === "fleet" && right.kind === "fleet"
    ? true
    : left.kind === "domain" && right.kind === "domain" &&
      left.domain === right.domain;
}

function scopeContainsSubject(
  scope: typeof AccessCeilingScopeV1Schema.Type,
  subject: AccessBindingSubjectV1,
) {
  return scope.fleet === subject.fleet &&
    (scope.kind === "fleet" || scope.domain === subject.domain);
}
