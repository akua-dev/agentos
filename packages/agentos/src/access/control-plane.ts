import { Context, Effect, Schema } from "effect";

import {
  AccessBindingV1Schema,
  AccessCeilingRefV1Schema,
  AccessProfileRefV1Schema,
  AccessProfileVersionV1Schema,
  authorizationResourceName,
  decodeAccessCeiling,
  decodeAccessProfileVersion,
  evaluateAccessRequest,
  type AccessBindingSubjectV1,
  type AccessBindingV1,
  type AccessCeilingV1,
  type AccessDecisionV1,
  type AccessPermissionV1,
  type AccessProfileVersionV1,
  type AccessRateClassId,
} from "./contracts.ts";
import {
  OpenFgaAuthorizationApi,
  OpenFgaMutationVerificationError,
  compileOpenFgaAuthorizationState,
  type OpenFgaApiCheckRequest,
  type OpenFgaDeploymentV1,
  type OpenFgaTupleDeleteV1,
  type OpenFgaTupleMutationV1,
  type OpenFgaTuplePlanV1,
  type OpenFgaTupleV1,
} from "./openfga.ts";

export const ACCESS_POLICY_RELOAD_SLO_MILLIS = 15_000;
export const ACCESS_POLICY_REVOCATION_SLO_MILLIS = 60_000;

const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const AccessControlOperationId = Uuid;
const AccessControlMutationReason = Schema.Literals([
  "assignment_requirement",
  "operator_request",
  "least_privilege",
  "incident_response",
  "ceiling_changed",
  "assignment_ended",
]);

export const AccessControlMutationRecordV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^authz_[0-9a-f]{32}$/)),
  ),
  operationId: AccessControlOperationId,
  timestampMillis: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  actor: Schema.Struct({
    agentId: Uuid,
    serviceAccountUid: Uuid,
  }),
  correlationId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^corr_[0-9a-f]{32}$/)),
  ),
  kind: Schema.Literals([
    "profile_published",
    "binding_created",
    "binding_revoked",
    "ceiling_reconciled",
  ]),
  target: Schema.Union([
    Schema.Struct({
      profile: AccessProfileRefV1Schema,
      ceiling: AccessCeilingRefV1Schema,
    }),
    Schema.Struct({
      bindingId: AccessBindingV1Schema.fields.bindingId,
      subject: AccessBindingV1Schema.fields.subject,
      profile: AccessProfileRefV1Schema,
    }),
  ]),
  previousVersion: Schema.NullOr(Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  )),
  newVersion: Schema.NullOr(Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  )),
  mutationReason: AccessControlMutationReason,
  decision: Schema.Literals(["recorded", "denied"]),
});

export type AccessControlMutationRecordV1 =
  typeof AccessControlMutationRecordV1Schema.Type;

export class AccessControlAuditDecodeError extends Schema.TaggedErrorClass<AccessControlAuditDecodeError>()(
  "AccessControlAuditDecodeError",
  { boundary: Schema.Literal("access_control_audit") },
) {}

export const decodeAccessControlMutationRecord = Effect.fn(
  "agentos.access.decodeControlMutationRecord",
)((input: unknown) =>
  Schema.decodeUnknownEffect(AccessControlMutationRecordV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() => AccessControlAuditDecodeError.make({
      boundary: "access_control_audit",
    })),
  ));

const AccessControlPolicyErrorCode = Schema.Literals([
  "ceiling_denied",
  "expiry_exceeded",
  "no_effective_permissions",
  "optimistic_conflict",
  "rate_class_exceeded",
  "tuple_collision",
]);

export class AccessControlPolicyError extends Schema.TaggedErrorClass<AccessControlPolicyError>()(
  "AccessControlPolicyError",
  {
    code: AccessControlPolicyErrorCode,
    boundary: Schema.String,
  },
) {}

export class AccessControlOperationSloExceeded extends Schema.TaggedErrorClass<AccessControlOperationSloExceeded>()(
  "AccessControlOperationSloExceeded",
  { sloMillis: Schema.Number },
) {}

export class AccessControlOperationFailed extends Schema.TaggedErrorClass<AccessControlOperationFailed>()(
  "AccessControlOperationFailed",
  { operationId: Schema.String },
) {}

export class AccessControlOperationPlanMismatch extends Schema.TaggedErrorClass<AccessControlOperationPlanMismatch>()(
  "AccessControlOperationPlanMismatch",
  { operationId: Schema.String },
) {}

export interface AccessControlVerificationV1 {
  readonly request: OpenFgaApiCheckRequest;
  readonly expectedAllowed: boolean;
}

export interface AccessControlTupleTransitionV1 {
  readonly subject: string;
  readonly stages: readonly [
    AccessControlTupleStageV1,
    ...Array<AccessControlTupleStageV1>,
  ];
  /** Final-state checks retained as a convenient inspection surface. */
  readonly verifications: readonly [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ];
}

export interface AccessControlTupleStageV1 {
  readonly mutation: OpenFgaTupleMutationV1;
  readonly verifications: readonly [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ];
}

export interface AccessCeilingBindingStateV1 {
  readonly profile: AccessProfileVersionV1;
  readonly binding: AccessBindingV1;
}

export interface AccessCeilingReconciliationV1 {
  readonly subjects: readonly [
    AccessBindingSubjectV1,
    ...Array<AccessBindingSubjectV1>,
  ];
  readonly stages: readonly [
    AccessControlTupleStageV1,
    ...Array<AccessControlTupleStageV1>,
  ];
  readonly verifications: readonly [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ];
}

export interface AccessControlOperationV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly phase: "prepared" | "verified" | "completed" | "failed";
  readonly nextStageIndex: number;
  readonly kind:
    | "profile_published"
    | "binding_created"
    | "binding_revoked"
    | "ceiling_reconciled";
  readonly subjects: readonly [
    AccessBindingSubjectV1,
    ...Array<AccessBindingSubjectV1>,
  ];
  readonly stages: readonly [
    AccessControlTupleStageV1,
    ...Array<AccessControlTupleStageV1>,
  ];
  readonly audit: AccessControlMutationRecordV1;
}

export class AccessControlJournal extends Context.Service<
  AccessControlJournal,
  {
    readonly load: (
      operationId: string,
    ) => Effect.Effect<AccessControlOperationV1, Error>;
    readonly advanceStage: (
      operationId: string,
      expectedStageIndex: number,
    ) => Effect.Effect<void, Error>;
    readonly complete: (operationId: string) => Effect.Effect<void, Error>;
  }
>()("agentos/access/AccessControlJournal") {}

/** Implemented only by the trusted core service from freshly loaded durable state. */
export class AccessControlOperationGuard extends Context.Service<
  AccessControlOperationGuard,
  {
    readonly validate: (
      operation: AccessControlOperationV1,
    ) => Effect.Effect<void, AccessControlOperationPlanMismatch | Error>;
  }
>()("agentos/access/AccessControlOperationGuard") {}

export class AccessControlIdentityCache extends Context.Service<
  AccessControlIdentityCache,
  {
    readonly invalidate: (
      subject: AccessBindingSubjectV1,
    ) => Effect.Effect<void, Error>;
  }
>()("agentos/access/AccessControlIdentityCache") {}

export const validateAccessControlOperationPlan = Effect.fn(
  "agentos.access.validateControlOperationPlan",
)(function*(
  operation: AccessControlOperationV1,
  expected: Pick<AccessControlOperationV1, "subjects" | "stages">,
) {
  if (
    JSON.stringify(operation.subjects) !== JSON.stringify(expected.subjects) ||
    JSON.stringify(operation.stages) !== JSON.stringify(expected.stages)
  ) {
    return yield* AccessControlOperationPlanMismatch.make({
      operationId: operation.operationId,
    });
  }
  return;
});

export interface PublishAccessProfileVersionInput {
  readonly ceiling: AccessCeilingV1;
  readonly previousProfile: AccessProfileVersionV1 | null;
  readonly expectedPreviousVersion: number | null;
  readonly profileId: string;
  readonly permissions: readonly [
    AccessPermissionV1,
    ...Array<AccessPermissionV1>,
  ];
}

const RateClassRank: Readonly<Record<AccessRateClassId, number>> =
  Object.freeze({ disabled: 0, low: 1, standard: 2, high: 3 });

export const publishAccessProfileVersion = Effect.fn(
  "agentos.access.publishProfileVersion",
)(function*(input: PublishAccessProfileVersionInput) {
  const ceiling = yield* decodeAccessCeiling(input.ceiling);
  const previous = input.previousProfile === null
    ? null
    : yield* decodeAccessProfileVersion(input.previousProfile);
  const actualPreviousVersion = previous?.profileVersion ?? null;
  if (
    input.expectedPreviousVersion !== actualPreviousVersion ||
    (previous !== null && previous.profileId !== input.profileId)
  ) {
    return yield* policyError("optimistic_conflict", "profile.version");
  }

  for (const permission of input.permissions) {
    const ceilingPermission = ceiling.permissions.find((candidate) =>
      permissionKey(candidate) === permissionKey(permission)
    );
    if (ceilingPermission === undefined) {
      return yield* policyError("ceiling_denied", "profile.permissions");
    }
    if (
      RateClassRank[permission.rateClass] >
        RateClassRank[ceilingPermission.rateClass]
    ) {
      return yield* policyError(
        "rate_class_exceeded",
        "profile.permissions.rateClass",
      );
    }
    if (
      ceilingPermission.expiresAtMillis !== null &&
      (permission.expiresAtMillis === null ||
        permission.expiresAtMillis > ceilingPermission.expiresAtMillis)
    ) {
      return yield* policyError(
        "expiry_exceeded",
        "profile.permissions.expiresAtMillis",
      );
    }
  }

  const profile = yield* decodeAccessProfileVersion({
    schemaVersion: 1,
    compatibility: "agentos-access-v1",
    profileId: input.profileId,
    profileVersion: (actualPreviousVersion ?? 0) + 1,
    previousProfileVersion: actualPreviousVersion,
    publishedBy: "first-mate-control-plane",
    permissions: input.permissions,
  });
  return deepFreeze(profile);
});

interface AccessControlTupleState {
  readonly ceiling: AccessCeilingV1;
  readonly profile: AccessProfileVersionV1;
  readonly binding: AccessBindingV1;
}

interface PrepareAccessControlTupleTransitionInput {
  readonly deployment: OpenFgaDeploymentV1;
  readonly previous: AccessControlTupleState | null;
  readonly next: AccessControlTupleState;
}

export const prepareAccessControlTupleTransition = Effect.fn(
  "agentos.access.prepareTupleTransition",
)(function*(input: PrepareAccessControlTupleTransitionInput) {
  const previous = input.previous === null
    ? null
    : yield* compileOpenFgaAuthorizationState(input.previous);
  const next = yield* compileOpenFgaAuthorizationState(input.next);
  const atMillis = verificationTime(input.previous, input.next);
  const prepared = yield* prepareStagedTuplePlanTransition(
    input.deployment,
    previous,
    next,
    atMillis,
  );

  return {
    subject: next.subject,
    stages: prepared.stages,
    verifications: prepared.verifications,
  } satisfies AccessControlTupleTransitionV1;
});

export interface PrepareAccessCeilingReconciliationInput {
  readonly deployment: OpenFgaDeploymentV1;
  readonly previousCeiling: AccessCeilingV1;
  readonly nextCeiling: AccessCeilingV1;
  readonly bindings: readonly [
    AccessCeilingBindingStateV1,
    ...Array<AccessCeilingBindingStateV1>,
  ];
}

export const prepareAccessCeilingReconciliation = Effect.fn(
  "agentos.access.prepareCeilingReconciliation",
)(function*(input: PrepareAccessCeilingReconciliationInput) {
  const [firstBinding, ...remainingBindings] = input.bindings;
  const firstPreviousPlan = yield* compileOpenFgaAuthorizationState({
    ceiling: input.previousCeiling,
    profile: firstBinding.profile,
    binding: firstBinding.binding,
  });
  const firstNextPlan = yield* compileOpenFgaAuthorizationState({
    ceiling: input.nextCeiling,
    profile: firstBinding.profile,
    binding: firstBinding.binding,
  });
  const previousPlans: [OpenFgaTuplePlanV1, ...Array<OpenFgaTuplePlanV1>] = [
    firstPreviousPlan,
  ];
  const nextPlans: [OpenFgaTuplePlanV1, ...Array<OpenFgaTuplePlanV1>] = [
    firstNextPlan,
  ];
  const subjects = new Map<string, AccessBindingSubjectV1>();
  subjects.set(
    JSON.stringify(firstBinding.binding.subject),
    firstBinding.binding.subject,
  );
  let atMillis = Math.max(
    input.previousCeiling.effectiveAtMillis,
    input.nextCeiling.effectiveAtMillis,
    firstBinding.binding.createdAtMillis,
  ) + 1;
  for (const state of remainingBindings) {
    const subjectKey = JSON.stringify(state.binding.subject);
    if (subjects.has(subjectKey)) {
      return yield* policyError("tuple_collision", "ceiling.subjects");
    }
    subjects.set(subjectKey, state.binding.subject);
    previousPlans.push(yield* compileOpenFgaAuthorizationState({
      ceiling: input.previousCeiling,
      profile: state.profile,
      binding: state.binding,
    }));
    nextPlans.push(yield* compileOpenFgaAuthorizationState({
      ceiling: input.nextCeiling,
      profile: state.profile,
      binding: state.binding,
    }));
    atMillis = Math.max(atMillis, state.binding.createdAtMillis + 1);
  }
  const previous = yield* mergeTuplePlans(previousPlans);
  const next = yield* mergeTuplePlans(nextPlans);
  const prepared = yield* prepareStagedTuplePlanTransition(
    input.deployment,
    previous,
    next,
    atMillis,
  );
  const [firstSubject, ...remainingSubjects] = [...subjects.values()];
  if (firstSubject === undefined) {
    return yield* policyError("no_effective_permissions", "ceiling.subjects");
  }
  return {
    subjects: [firstSubject, ...remainingSubjects],
    stages: prepared.stages,
    verifications: prepared.verifications,
  } satisfies AccessCeilingReconciliationV1;
});

interface EffectiveAccessForBindingInput extends AccessControlTupleState {
  readonly atMillis: number;
}

export const effectiveAccessForBinding = Effect.fn(
  "agentos.access.effectiveAccessForBinding",
)(function*(input: EffectiveAccessForBindingInput) {
  const allowed: Array<AccessDecisionV1> = [];
  for (const permission of input.profile.permissions) {
    const decision = yield* evaluateAccessRequest({
      atMillis: input.atMillis,
      subject: input.binding.subject,
      ceiling: input.ceiling,
      profile: input.profile,
      binding: input.binding,
      capability: permission.capability,
      resource: permission.resource,
      environment: permission.environment,
    });
    if (decision.decision === "allow") allowed.push(decision);
  }
  return allowed.sort((left, right) =>
    permissionKey(left).localeCompare(permissionKey(right)));
});

const executeAccessControlOperationUnbounded = Effect.fn(
  "agentos.access.executeControlOperation.unbounded",
)(function*(operationId: string) {
  const journal = yield* AccessControlJournal;
  const authorization = yield* OpenFgaAuthorizationApi;
  const identityCache = yield* AccessControlIdentityCache;
  const guard = yield* AccessControlOperationGuard;
  let operation = yield* journal.load(operationId);
  if (operation.phase === "completed") return operation;
  if (operation.phase === "failed") {
    return yield* AccessControlOperationFailed.make({ operationId });
  }
  yield* guard.validate(operation);

  while (operation.phase === "prepared") {
    const stageIndex = operation.nextStageIndex;
    const stage = operation.stages[stageIndex];
    if (stage === undefined) {
      return yield* AccessControlOperationFailed.make({ operationId });
    }
    yield* authorization.mutateTuples({
      ...deploymentFrom(stage.verifications),
      mutation: stage.mutation,
    });
    for (const item of stage.verifications) {
      const allowed = yield* authorization.check(item.request);
      if (allowed !== item.expectedAllowed) {
        return yield* OpenFgaMutationVerificationError.make({
          code: "unexpected_decision",
        });
      }
    }
    yield* journal.advanceStage(operationId, stageIndex);
    operation = yield* journal.load(operationId);
    if (operation.phase === "failed") {
      return yield* AccessControlOperationFailed.make({ operationId });
    }
  }

  for (const subject of operation.subjects) {
    yield* identityCache.invalidate(subject);
  }
  yield* journal.complete(operationId);
  return yield* journal.load(operationId);
});

export const executeAccessControlOperation = Effect.fn(
  "agentos.access.executeControlOperation",
)((operationId: string) =>
  executeAccessControlOperationUnbounded(operationId).pipe(
    Effect.timeoutOrElse({
      duration: ACCESS_POLICY_REVOCATION_SLO_MILLIS,
      orElse: () => AccessControlOperationSloExceeded.make({
        sloMillis: ACCESS_POLICY_REVOCATION_SLO_MILLIS,
      }),
    }),
  ));

function deploymentFrom(
  verifications: readonly [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ],
) {
  const first = verifications[0];
  return {
    storeId: first.request.storeId,
    authorizationModelId: first.request.authorizationModelId,
  };
}

function verification(
  deployment: OpenFgaDeploymentV1,
  tuple: OpenFgaTuplePlanV1["tuples"][number],
  atMillis: number,
  expectedAllowed: boolean,
): AccessControlVerificationV1 {
  return {
    request: {
      ...deployment,
      user: tuple.user,
      relation: tuple.relation,
      object: tuple.object,
      context: { current_time: new Date(atMillis).toISOString() },
      consistency: "HIGHER_CONSISTENCY",
    },
    expectedAllowed,
  };
}

function grantMap(plan: OpenFgaTuplePlanV1 | null) {
  return new Map(
    (plan?.tuples ?? [])
      .filter(({ relation }) => relation.startsWith("allow_"))
      .map((tuple) => [tupleKey(tuple), tuple]),
  );
}

function mergeTuplePlans(plans: readonly [
  OpenFgaTuplePlanV1,
  ...Array<OpenFgaTuplePlanV1>,
]) {
  return Effect.gen(function*() {
    const tuples = new Map<string, OpenFgaTupleV1>();
    for (const plan of plans) {
      for (const tuple of plan.tuples) {
        const key = tupleKey(tuple);
        const prior = tuples.get(key);
        if (prior !== undefined && !sameTupleCondition(prior, tuple)) {
          return yield* policyError("tuple_collision", "ceiling.tuples");
        }
        tuples.set(key, tuple);
      }
    }
    return {
      ...plans[0],
      tuples: [...tuples.values()].sort((left, right) =>
        tupleKey(left).localeCompare(tupleKey(right))),
    } satisfies OpenFgaTuplePlanV1;
  });
}

function prepareStagedTuplePlanTransition(
  deployment: OpenFgaDeploymentV1,
  previous: OpenFgaTuplePlanV1 | null,
  next: OpenFgaTuplePlanV1,
  atMillis: number,
) {
  return Effect.gen(function*() {
    const before = new Map(
      (previous?.tuples ?? []).map((tuple) => [tupleKey(tuple), tuple]),
    );
    const after = new Map(next.tuples.map((tuple) => [tupleKey(tuple), tuple]));
    const deletes: Array<OpenFgaTupleDeleteV1> = [];
    const writes: Array<OpenFgaTupleV1> = [];
    const replacements: Array<OpenFgaTupleV1> = [];

    for (const [key, tuple] of before) {
      const replacement = after.get(key);
      if (replacement === undefined) {
        deletes.push(deleteTuple(tuple));
      } else if (!sameTupleCondition(tuple, replacement)) {
        deletes.push(deleteTuple(tuple));
        replacements.push(tuple);
      }
    }
    for (const [key, tuple] of after) {
      const prior = before.get(key);
      if (prior === undefined || !sameTupleCondition(prior, tuple)) {
        writes.push(tuple);
      }
    }
    const finalVerifications = yield* finalStateVerifications(
      deployment,
      previous,
      next,
      atMillis,
    );
    if (replacements.length === 0) {
      const stages: [AccessControlTupleStageV1] = [{
        mutation: sortMutation({ writes, deletes }),
        verifications: finalVerifications,
      }];
      return {
        stages,
        verifications: finalVerifications,
      } satisfies PreparedStagedTuplePlanTransition;
    }

    const changedGrantVerifications = replacements
      .filter(({ relation }) => relation.startsWith("allow_"))
      .map((tuple) => verification(deployment, tuple, atMillis, false));
    for (const item of finalVerifications) {
      if (!item.expectedAllowed) changedGrantVerifications.push(item);
    }
    const firstStageVerifications = yield* nonEmptyVerifications(
      changedGrantVerifications,
    );

    const stages: [AccessControlTupleStageV1, AccessControlTupleStageV1] = [
      {
        mutation: sortMutation({ writes: [], deletes }),
        verifications: firstStageVerifications,
      },
      {
        mutation: sortMutation({ writes, deletes: [] }),
        verifications: finalVerifications,
      },
    ];
    return {
      stages,
      verifications: finalVerifications,
    } satisfies PreparedStagedTuplePlanTransition;
  });
}

interface PreparedStagedTuplePlanTransition {
  readonly stages: readonly [
    AccessControlTupleStageV1,
    ...Array<AccessControlTupleStageV1>,
  ];
  readonly verifications: readonly [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ];
}

function finalStateVerifications(
  deployment: OpenFgaDeploymentV1,
  previous: OpenFgaTuplePlanV1 | null,
  next: OpenFgaTuplePlanV1,
  atMillis: number,
) {
  const previousGrants = grantMap(previous);
  const nextGrants = grantMap(next);
  const values: Array<AccessControlVerificationV1> = [];
  for (const [key, tuple] of nextGrants) {
    values.push(verification(deployment, tuple, atMillis, true));
    previousGrants.delete(key);
  }
  for (const tuple of previousGrants.values()) {
    values.push(verification(deployment, tuple, atMillis, false));
  }
  return nonEmptyVerifications(values);
}

function nonEmptyVerifications(values: Array<AccessControlVerificationV1>) {
  const deduplicated = new Map(
    values.map((item) => [`${verificationKey(item)}\u0000${item.expectedAllowed}`, item]),
  );
  const [first, ...remaining] = [...deduplicated.values()].sort(
    (left, right) => verificationKey(left).localeCompare(verificationKey(right)),
  );
  if (first === undefined) {
    return Effect.fail(policyError(
      "no_effective_permissions",
      "binding.permissions",
    ));
  }
  const result: [
    AccessControlVerificationV1,
    ...Array<AccessControlVerificationV1>,
  ] = [first, ...remaining];
  return Effect.succeed(result);
}

function sameTupleCondition(left: OpenFgaTupleV1, right: OpenFgaTupleV1) {
  return JSON.stringify(left.condition) === JSON.stringify(right.condition);
}

function deleteTuple(tuple: OpenFgaTupleV1): OpenFgaTupleDeleteV1 {
  return { user: tuple.user, relation: tuple.relation, object: tuple.object };
}

function sortMutation(mutation: OpenFgaTupleMutationV1): OpenFgaTupleMutationV1 {
  const compare = (left: { user: string; relation: string; object: string }, right: { user: string; relation: string; object: string }) =>
    tupleKey(left).localeCompare(tupleKey(right));
  return {
    writes: [...mutation.writes].sort(compare),
    deletes: [...mutation.deletes].sort(compare),
  };
}

function tupleKey(tuple: { readonly user: string; readonly relation: string; readonly object: string }) {
  return `${tuple.object}\u0000${tuple.relation}\u0000${tuple.user}`;
}

function verificationKey(value: AccessControlVerificationV1) {
  return `${value.request.object}\u0000${value.request.relation}\u0000${value.request.user}`;
}

function verificationTime(
  previous: AccessControlTupleState | null,
  next: AccessControlTupleState,
) {
  const effective = Math.max(
    previous?.binding.createdAtMillis ?? 0,
    previous?.ceiling.effectiveAtMillis ?? 0,
    next.binding.createdAtMillis,
    next.ceiling.effectiveAtMillis,
  );
  return effective + 1;
}

function permissionKey(permission: Pick<AccessPermissionV1, "capability" | "resource" | "environment">) {
  return [
    permission.capability,
    authorizationResourceName(permission.resource),
    permission.environment ?? "-",
  ].join("\u0000");
}

function policyError(
  code: AccessControlPolicyError["code"],
  boundary: string,
) {
  return AccessControlPolicyError.make({ code, boundary });
}

function deepFreeze<A>(value: A): A {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
