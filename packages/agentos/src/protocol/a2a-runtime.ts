import { Clock, Context, Effect, Layer, Schema } from "effect";

import {
  authorizationResourceName,
  authorizationSubjectName,
  type AccessBindingSubjectV1,
  type AccessPermissionV1,
} from "../access/contracts.ts";
import {
  WorkloadIdentityV1Schema,
  type WorkloadIdentityV1,
} from "../access/identity.ts";
import {
  AGENTOS_OPENFGA_HEALTH_OBJECT,
  AGENTOS_OPENFGA_HEALTH_RELATION,
  AGENTOS_OPENFGA_HEALTH_USER,
  OpenFgaAuthorizationApi,
  openFgaCapabilityRelation,
  openFgaCeiling,
  openFgaProfile,
  openFgaSubject,
  openFgaTarget,
  type OpenFgaDeploymentV1,
} from "../access/openfga.ts";
import {
  ProviderPolicySnapshotStore,
  type ProviderPolicySnapshotUnavailable,
  type ProviderPolicySnapshotV1,
} from "../access/postgres-identity.ts";
import { A2aSpeechActV1Schema } from "./a2a.ts";

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const SkillIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9._-]*@v[1-9][0-9]*$/),
  ),
);
const SubjectSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
);

export const A2aCanonicalReferenceVerificationV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  taskId: Schema.NullOr(UuidSchema),
  assignmentId: Schema.NullOr(UuidSchema),
  callerAgentId: UuidSchema,
  targetAgentId: UuidSchema,
  speechAct: A2aSpeechActV1Schema,
  skillId: SkillIdSchema,
  subject: SubjectSchema,
});

export const A2aVerifiedCanonicalReferenceV1Schema = Schema.Struct({
  ...A2aCanonicalReferenceVerificationV1Schema.fields,
  canonicalInbox: Schema.Literals(["unread", "read", "resolved"]),
  a2aContextId: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(64),
      Schema.isPattern(/^agentos:(?:task|inbox):[0-9a-f-]{36}$/),
    ),
  ),
});

export const A2aDeliveryProjectionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  taskId: Schema.NullOr(UuidSchema),
  contextId: A2aVerifiedCanonicalReferenceV1Schema.fields.a2aContextId,
  state: Schema.Literals([
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_COMPLETED",
  ]),
  canonicalInbox: Schema.Literals(["unread", "read", "resolved"]),
  skillId: SkillIdSchema,
  assignmentId: Schema.NullOr(UuidSchema),
});

export class A2aCanonicalStoreError extends Schema.TaggedErrorClass<A2aCanonicalStoreError>()(
  "A2aCanonicalStoreError",
  {
    outcome: Schema.Literals([
      "dependency_unavailable",
      "reference_denied",
    ]),
    retryable: Schema.Boolean,
  },
) {}

export class A2aCanonicalDeliveryStore extends Context.Service<
  A2aCanonicalDeliveryStore,
  {
    readonly verify: (
      request: typeof A2aCanonicalReferenceVerificationV1Schema.Type,
    ) => Effect.Effect<
      typeof A2aVerifiedCanonicalReferenceV1Schema.Type,
      A2aCanonicalStoreError
    >;
    readonly wake: (
      inboxId: string,
    ) => Effect.Effect<{
      readonly version: 1;
      readonly inboxId: string;
      readonly recovery: "postgresql_listener_then_herdr_wake";
    }, A2aCanonicalStoreError>;
    readonly project: (
      request: {
        readonly inboxId: string;
        readonly callerAgentId: string;
        readonly targetAgentId: string;
      },
    ) => Effect.Effect<
      typeof A2aDeliveryProjectionV1Schema.Type,
      A2aCanonicalStoreError
    >;
    readonly ready: Effect.Effect<boolean>;
  }
>()("agentos/protocol/A2aCanonicalDeliveryStore") {}

export const A2aPolicyAuthorizationRequestV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  identity: WorkloadIdentityV1Schema,
  targetAgentId: UuidSchema,
  skillId: SkillIdSchema,
  assignmentId: Schema.NullOr(UuidSchema),
});

export const A2aPolicyGrantV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  callerAgentId: UuidSchema,
  targetAgentId: UuidSchema,
  skillId: SkillIdSchema,
  profileId: Schema.String,
  profileVersion: Schema.Number,
  ceilingId: Schema.String,
  ceilingRevision: Schema.Number,
});

export class A2aPolicyError extends Schema.TaggedErrorClass<A2aPolicyError>()(
  "A2aPolicyError",
  {
    outcome: Schema.Literals(["denied", "dependency_unavailable"]),
    retryable: Schema.Boolean,
  },
) {}

export interface A2aPolicyAuthorizationRequestV1 {
  readonly version: 1;
  readonly identity: WorkloadIdentityV1;
  readonly targetAgentId: string;
  readonly skillId: string;
  readonly assignmentId: string | null;
}

export interface A2aSkillFilterRequestV1 {
  readonly version: 1;
  readonly identity: WorkloadIdentityV1;
  readonly targetAgentId: string;
  readonly skillIds: ReadonlyArray<string>;
}

export class A2aPolicyAuthorizer extends Context.Service<
  A2aPolicyAuthorizer,
  {
    readonly authorize: (
      request: A2aPolicyAuthorizationRequestV1,
    ) => Effect.Effect<typeof A2aPolicyGrantV1Schema.Type, A2aPolicyError>;
    readonly filterAuthorizedSkills: (
      request: A2aSkillFilterRequestV1,
    ) => Effect.Effect<ReadonlyArray<string>, A2aPolicyError>;
    readonly ready: Effect.Effect<boolean>;
  }
>()("agentos/protocol/A2aPolicyAuthorizer") {}

export const A2aTransportTelemetryEventV1Schema = Schema.Struct({
  method: Schema.Literals([
    "AgentCard",
    "ExternalAuthorize",
    "GetTask",
    "SendMessage",
  ]),
  outcome: Schema.Literals([
    "accepted",
    "denied",
    "dependency_unavailable",
    "invalid_request",
    "not_found",
  ]),
  retry: Schema.Boolean,
  timedOut: Schema.Boolean,
  recovery: Schema.Literals([
    "not_required",
    "postgresql_listener_then_herdr_wake",
  ]),
  targetAgentId: Schema.NullOr(UuidSchema),
  skillId: Schema.NullOr(SkillIdSchema),
  inboxId: Schema.NullOr(UuidSchema),
  taskId: Schema.NullOr(UuidSchema),
  assignmentId: Schema.NullOr(UuidSchema),
});

export class A2aTransportTelemetry extends Context.Service<
  A2aTransportTelemetry,
  {
    readonly emit: (
      event: typeof A2aTransportTelemetryEventV1Schema.Type,
    ) => Effect.Effect<void>;
  }
>()("agentos/protocol/A2aTransportTelemetry") {
  static readonly noop = Layer.succeed(A2aTransportTelemetry, {
    emit: () => Effect.void,
  });
}

const RateClassRank = Object.freeze({
  disabled: 0,
  low: 1,
  standard: 2,
  high: 3,
});

export function makeA2aPolicyAuthorizerLayer(options: {
  readonly deployment: OpenFgaDeploymentV1;
  readonly environment: string | null;
}) {
  return Layer.effect(A2aPolicyAuthorizer, Effect.gen(function*() {
    const snapshots = yield* ProviderPolicySnapshotStore;
    const openFga = yield* OpenFgaAuthorizationApi;

    const authorize = Effect.fn("agentos.a2aPolicy.authorize")(
      function*(request: A2aPolicyAuthorizationRequestV1) {
        const subject = subjectForIdentity(request.identity);
        const snapshot = yield* snapshots.findBySubject(subject).pipe(
          Effect.mapError(mapSnapshotFailure),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* validateSnapshot(snapshot, subject, now);
        const resource: Extract<
          AccessPermissionV1["resource"],
          { kind: "agent_skill" }
        > = {
          kind: "agent_skill",
          targetAgentId: request.targetAgentId,
          skillId: request.skillId,
        };
        const profilePermission = yield* findPermission(
          snapshot.profile.permissions,
          resource,
          options.environment,
          now,
        );
        const ceilingPermission = yield* findPermission(
          snapshot.ceiling.permissions,
          resource,
          options.environment,
          now,
        );
        if (
          profilePermission.rateClass === "disabled" ||
          ceilingPermission.rateClass === "disabled" ||
          RateClassRank[profilePermission.rateClass] >
            RateClassRank[ceilingPermission.rateClass]
        ) {
          return yield* policyError("denied", false);
        }
        const relation = openFgaCapabilityRelation("agentos.a2a.send");
        const target = openFgaTarget(subject.fleet, profilePermission);
        const context = { current_time: new Date(now).toISOString() };
        const checks = yield* Effect.all([
          openFga.check({
            ...options.deployment,
            user: openFgaProfile(subject.fleet, snapshot.profile),
            relation: relation.profile,
            object: target,
            context,
            consistency: "HIGHER_CONSISTENCY",
          }),
          openFga.check({
            ...options.deployment,
            user: openFgaCeiling(subject.fleet, snapshot.ceiling),
            relation: relation.ceiling,
            object: target,
            context,
            consistency: "HIGHER_CONSISTENCY",
          }),
          openFga.check({
            ...options.deployment,
            user: openFgaSubject(subject),
            relation: relation.allow,
            object: target,
            context,
            consistency: "HIGHER_CONSISTENCY",
          }),
        ], { concurrency: 3 }).pipe(
          Effect.mapError(() => policyError("dependency_unavailable", true)),
        );
        if (checks.some((allowed) => !allowed)) {
          return yield* policyError("denied", false);
        }
        const grant: typeof A2aPolicyGrantV1Schema.Type = {
          version: 1,
          callerAgentId: request.identity.agentId,
          targetAgentId: request.targetAgentId,
          skillId: request.skillId,
          profileId: snapshot.profile.profileId,
          profileVersion: snapshot.profile.profileVersion,
          ceilingId: snapshot.ceiling.ceilingId,
          ceilingRevision: snapshot.ceiling.revision,
        };
        return grant;
      },
    );

    return A2aPolicyAuthorizer.of({
      authorize,
      filterAuthorizedSkills: Effect.fn("agentos.a2aPolicy.filterSkills")(
        function*(request: A2aSkillFilterRequestV1) {
          const allowed = yield* Effect.forEach(request.skillIds, (skillId) =>
            authorize({
              version: 1,
              identity: request.identity,
              targetAgentId: request.targetAgentId,
              skillId,
              assignmentId: null,
            }).pipe(
              Effect.map(() => skillId),
              Effect.catch((error) =>
                error.outcome === "denied"
                  ? Effect.succeed(null)
                  : Effect.fail(error)
              ),
            ));
          return allowed.filter((skillId): skillId is string => skillId !== null);
        },
      ),
      ready: openFga.check({
        ...options.deployment,
        user: AGENTOS_OPENFGA_HEALTH_USER,
        relation: AGENTOS_OPENFGA_HEALTH_RELATION,
        object: AGENTOS_OPENFGA_HEALTH_OBJECT,
        context: {},
        consistency: "HIGHER_CONSISTENCY",
      }).pipe(Effect.catch(() => Effect.succeed(false))),
    });
  }));
}

function subjectForIdentity(identity: WorkloadIdentityV1): AccessBindingSubjectV1 {
  if (identity.assignmentId !== null) {
    return {
      kind: "assignment",
      fleet: identity.fleet,
      domain: identity.domain,
      assignmentId: identity.assignmentId,
    };
  }
  return {
    kind: "mate",
    fleet: identity.fleet,
    domain: identity.domain,
    agentId: identity.agentId,
  };
}

function mapSnapshotFailure(
  error: ProviderPolicySnapshotUnavailable,
): A2aPolicyError {
  switch (error.code) {
    case "binding_not_found":
    case "binding_pending":
    case "binding_expired":
    case "binding_not_effective":
    case "subject_mismatch":
      return policyError("denied", false);
    case "database_unavailable":
    case "invalid_response":
    case "binding_ambiguous":
    case "profile_stale":
    case "reference_mismatch":
    case "ceiling_reconciliation_pending":
    case "ceiling_inactive":
    case "ceiling_not_effective":
    case "operation_unreconciled":
      return policyError("dependency_unavailable", true);
  }
}

function validateSnapshot(
  snapshot: ProviderPolicySnapshotV1,
  subject: AccessBindingSubjectV1,
  now: number,
) {
  if (
    authorizationSubjectName(snapshot.binding.subject) !==
      authorizationSubjectName(subject) ||
    snapshot.binding.createdAtMillis > now ||
    (snapshot.binding.expiresAtMillis !== null &&
      snapshot.binding.expiresAtMillis <= now)
  ) {
    return Effect.fail(policyError("denied", false));
  }
  const profileScope = snapshot.profile.targetScope;
  const ceilingScope = snapshot.ceiling.scope;
  if (
    snapshot.profile.issuedUnderCeiling.ceilingId !==
      snapshot.ceiling.ceilingId ||
    snapshot.profile.issuedUnderCeiling.revision !==
      snapshot.ceiling.revision ||
    profileScope.kind !== ceilingScope.kind ||
    profileScope.fleet !== ceilingScope.fleet ||
    (profileScope.kind === "domain" &&
      (ceilingScope.kind !== "domain" ||
        profileScope.domain !== ceilingScope.domain)) ||
    ceilingScope.fleet !== subject.fleet ||
    (ceilingScope.kind === "domain" && ceilingScope.domain !== subject.domain) ||
    snapshot.ceiling.effectiveAtMillis > now
  ) {
    return Effect.fail(policyError("dependency_unavailable", true));
  }
  return Effect.void;
}

function findPermission(
  permissions: ReadonlyArray<AccessPermissionV1>,
  resource: Extract<AccessPermissionV1["resource"], { kind: "agent_skill" }>,
  environment: string | null,
  now: number,
) {
  const key = authorizationResourceName(resource);
  const matches = permissions.filter((permission) =>
    permission.capability === "agentos.a2a.send" &&
    authorizationResourceName(permission.resource) === key &&
    permission.environment === environment
  );
  if (matches.length !== 1) return Effect.fail(policyError("denied", false));
  const permission = matches[0];
  if (
    permission === undefined ||
    (permission.expiresAtMillis !== null && permission.expiresAtMillis <= now)
  ) {
    return Effect.fail(policyError("denied", false));
  }
  return Effect.succeed(permission);
}

function policyError(
  outcome: A2aPolicyError["outcome"],
  retryable: boolean,
) {
  return A2aPolicyError.make({ outcome, retryable });
}
