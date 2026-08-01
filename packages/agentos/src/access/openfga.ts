import { Context, Effect, Schema } from "effect";

import {
  accessCapabilitiesV1,
  authorizationResourceName,
  authorizationSubjectName,
  decodeAccessBinding,
  decodeAccessCeiling,
  decodeAccessProfileVersion,
  type AccessBindingSubjectV1,
  type AccessBindingV1,
  type AccessCapabilityId,
  type AccessCeilingV1,
  type AccessPermissionV1,
  type AccessProfileVersionV1,
  type AccessRateClassId,
} from "./contracts.ts";

export const AGENTOS_OPENFGA_MODEL_VERSION = "agentos-access-v1";
export const AGENTOS_OPENFGA_STORE_NAME = "agentos-access-v1";
export const AGENTOS_OPENFGA_HEALTH_USER = "service:agentos-openfga";
export const AGENTOS_OPENFGA_HEALTH_OBJECT = "health_probe:agentos";
export const AGENTOS_OPENFGA_HEALTH_RELATION = "ready";
export const AGENTOS_OPENFGA_NO_EXPIRY = "9999-12-31T23:59:59.999Z";

const OpenFgaId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/)),
);
const OpenFgaTuplePart = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
    Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/),
  ),
);
const Rfc3339Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ),
  ),
);

export const OpenFgaActiveWindowConditionV1Schema = Schema.Struct({
  name: Schema.Literal("active_window"),
  context: Schema.Struct({
    effective_at: Rfc3339Timestamp,
    expires_at: Rfc3339Timestamp,
  }),
});

export const OpenFgaTupleV1Schema = Schema.Struct({
  user: OpenFgaTuplePart,
  relation: OpenFgaTuplePart,
  object: OpenFgaTuplePart,
  condition: Schema.NullOr(OpenFgaActiveWindowConditionV1Schema),
});

export const OpenFgaTupleDeleteV1Schema = Schema.Struct({
  user: OpenFgaTuplePart,
  relation: OpenFgaTuplePart,
  object: OpenFgaTuplePart,
});

export const OpenFgaTupleMutationV1Schema = Schema.Struct({
  writes: Schema.Array(OpenFgaTupleV1Schema),
  deletes: Schema.Array(OpenFgaTupleDeleteV1Schema),
});

export const OpenFgaDeploymentV1Schema = Schema.Struct({
  storeId: OpenFgaId,
  authorizationModelId: OpenFgaId,
});

export type OpenFgaActiveWindowConditionV1 =
  typeof OpenFgaActiveWindowConditionV1Schema.Type;
export type OpenFgaTupleV1 = typeof OpenFgaTupleV1Schema.Type;
export type OpenFgaTupleDeleteV1 = typeof OpenFgaTupleDeleteV1Schema.Type;
export type OpenFgaTupleMutationV1 = typeof OpenFgaTupleMutationV1Schema.Type;
export type OpenFgaDeploymentV1 = typeof OpenFgaDeploymentV1Schema.Type;

export interface OpenFgaCapabilityRelationV1 {
  readonly allow: string;
  readonly profile: string;
  readonly ceiling: string;
}

export interface OpenFgaTuplePlanV1 {
  readonly schemaVersion: 1;
  readonly modelVersion: typeof AGENTOS_OPENFGA_MODEL_VERSION;
  readonly fleet: string;
  readonly subject: string;
  readonly tuples: ReadonlyArray<OpenFgaTupleV1>;
}

const OpenFgaPolicyCompileErrorCode = Schema.Literals([
  "binding_profile_mismatch",
  "ceiling_id_mismatch",
  "issued_revision_ahead",
  "subject_outside_ceiling",
  "timestamp_out_of_range",
  "tuple_replacement_not_atomic",
]);

export class OpenFgaPolicyCompileError extends Schema.TaggedErrorClass<OpenFgaPolicyCompileError>()(
  "OpenFgaPolicyCompileError",
  {
    code: OpenFgaPolicyCompileErrorCode,
    boundary: Schema.String,
  },
) {}

export class OpenFgaDependencyUnavailable extends Schema.TaggedErrorClass<OpenFgaDependencyUnavailable>()(
  "OpenFgaDependencyUnavailable",
  {
    operation: Schema.Literals(["mutate_tuples", "check"]),
  },
) {}

export class OpenFgaMutationVerificationError extends Schema.TaggedErrorClass<OpenFgaMutationVerificationError>()(
  "OpenFgaMutationVerificationError",
  {
    code: Schema.Literal("unexpected_decision"),
  },
) {}

export interface OpenFgaApiTupleMutationRequest extends OpenFgaDeploymentV1 {
  readonly mutation: OpenFgaTupleMutationV1;
}

export interface OpenFgaApiCheckRequest extends OpenFgaDeploymentV1 {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly context: Readonly<Record<string, string>>;
  readonly consistency: "MINIMIZE_LATENCY" | "HIGHER_CONSISTENCY";
}

export class OpenFgaAuthorizationApi extends Context.Service<
  OpenFgaAuthorizationApi,
  {
    readonly mutateTuples: (
      request: OpenFgaApiTupleMutationRequest,
    ) => Effect.Effect<void, OpenFgaDependencyUnavailable>;
    readonly check: (
      request: OpenFgaApiCheckRequest,
    ) => Effect.Effect<boolean, OpenFgaDependencyUnavailable>;
  }
>()("agentos/access/OpenFgaAuthorizationApi") {}

interface ApplyOpenFgaMutationAndVerifyInput {
  readonly deployment: OpenFgaDeploymentV1;
  readonly mutation: OpenFgaTupleMutationV1;
  readonly verification: Omit<
    OpenFgaApiCheckRequest,
    keyof OpenFgaDeploymentV1 | "consistency"
  > & { readonly expectedAllowed: boolean };
}

export const applyOpenFgaMutationAndVerify = Effect.fn(
  "agentos.openfga.applyMutationAndVerify",
)(function*(input: ApplyOpenFgaMutationAndVerifyInput) {
  const api = yield* OpenFgaAuthorizationApi;
  yield* api.mutateTuples({
    ...input.deployment,
    mutation: input.mutation,
  });
  const allowed = yield* api.check({
    ...input.deployment,
    user: input.verification.user,
    relation: input.verification.relation,
    object: input.verification.object,
    context: input.verification.context,
    consistency: "HIGHER_CONSISTENCY",
  });
  if (allowed !== input.verification.expectedAllowed) {
    return yield* OpenFgaMutationVerificationError.make({
      code: "unexpected_decision",
    });
  }
});

type OpenFgaUserset =
  | { readonly this: Readonly<Record<string, never>> }
  | { readonly computedUserset: { readonly relation: string } }
  | {
    readonly tupleToUserset: {
      readonly tupleset: { readonly relation: string };
      readonly computedUserset: { readonly relation: string };
    };
  }
  | { readonly union: { readonly child: ReadonlyArray<OpenFgaUserset> } }
  | {
    readonly intersection: { readonly child: ReadonlyArray<OpenFgaUserset> };
  };

interface OpenFgaTypeDefinition {
  readonly type: string;
  readonly relations?: Readonly<Record<string, OpenFgaUserset>>;
  readonly metadata?: {
    readonly relations: Readonly<
      Record<
        string,
        {
          readonly directly_related_user_types: ReadonlyArray<{
            readonly type: string;
            readonly condition?: string;
          }>;
        }
      >
    >;
  };
}

export interface OpenFgaAuthorizationModelV1 {
  readonly schema_version: "1.1";
  readonly type_definitions: ReadonlyArray<OpenFgaTypeDefinition>;
  readonly conditions: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly expression: string;
        readonly parameters: Readonly<
          Record<string, { readonly type_name: "TYPE_NAME_TIMESTAMP" }>
        >;
      }
    >
  >;
}

const direct = (): OpenFgaUserset => ({ this: {} });
const computed = (relation: string): OpenFgaUserset => ({
  computedUserset: { relation },
});
const from = (tupleset: string, relation: string): OpenFgaUserset => ({
  tupleToUserset: {
    tupleset: { relation: tupleset },
    computedUserset: { relation },
  },
});
const union = (...child: ReadonlyArray<OpenFgaUserset>): OpenFgaUserset => ({
  union: { child },
});
const related = (
  ...types: ReadonlyArray<{ readonly type: string; readonly condition?: string }>
) => ({ directly_related_user_types: types });

const OpenFgaRateClassRank: Readonly<Record<AccessRateClassId, number>> =
  Object.freeze({
    disabled: 0,
    low: 1,
    standard: 2,
    high: 3,
  });

const capabilityTargetRelations: Record<string, OpenFgaUserset> = {};
const capabilityTargetMetadata: Record<
  string,
  ReturnType<typeof related>
> = {};
for (const { id } of accessCapabilitiesV1) {
  const relation = openFgaCapabilityRelation(id);
  capabilityTargetRelations[relation.profile] = direct();
  capabilityTargetRelations[relation.ceiling] = direct();
  capabilityTargetRelations[relation.allow] = direct();
  capabilityTargetMetadata[relation.profile] = related({
    type: "access_profile",
    condition: "active_window",
  });
  capabilityTargetMetadata[relation.ceiling] = related({
    type: "access_ceiling",
    condition: "active_window",
  });
  capabilityTargetMetadata[relation.allow] = related(
    { type: "mate", condition: "active_window" },
    { type: "assignment", condition: "active_window" },
  );
}

export const AgentOSOpenFgaAuthorizationModelV1 = deepFreeze<OpenFgaAuthorizationModelV1>({
  schema_version: "1.1",
  type_definitions: [
    { type: "service" },
    {
      type: "health_probe",
      relations: { ready: direct() },
      metadata: { relations: { ready: related({ type: "service" }) } },
    },
    { type: "mate" },
    { type: "assignment" },
    {
      type: "domain",
      relations: { member: direct() },
      metadata: {
        relations: {
          member: related({ type: "mate" }, { type: "assignment" }),
        },
      },
    },
    {
      type: "fleet",
      relations: {
        direct_member: direct(),
        domain: direct(),
        member: union(computed("direct_member"), from("domain", "member")),
      },
      metadata: {
        relations: {
          direct_member: related({ type: "mate" }, { type: "assignment" }),
          domain: related({ type: "domain" }),
        },
      },
    },
    {
      type: "access_profile",
      relations: { subject: direct() },
      metadata: {
        relations: {
          subject: related(
            { type: "mate", condition: "active_window" },
            { type: "assignment", condition: "active_window" },
          ),
        },
      },
    },
    {
      type: "access_ceiling",
      relations: { subject: direct() },
      metadata: {
        relations: {
          subject: related(
            { type: "mate", condition: "active_window" },
            { type: "assignment", condition: "active_window" },
          ),
        },
      },
    },
    {
      type: "authorization_target",
      relations: {
        fleet: direct(),
        ...capabilityTargetRelations,
      },
      metadata: {
        relations: {
          fleet: related({ type: "fleet" }),
          ...capabilityTargetMetadata,
        },
      },
    },
  ],
  conditions: {
    active_window: {
      name: "active_window",
      expression:
        "current_time >= effective_at && current_time < expires_at",
      parameters: {
        current_time: { type_name: "TYPE_NAME_TIMESTAMP" },
        effective_at: { type_name: "TYPE_NAME_TIMESTAMP" },
        expires_at: { type_name: "TYPE_NAME_TIMESTAMP" },
      },
    },
  },
});

export function openFgaCapabilityRelation(
  capability: AccessCapabilityId,
): OpenFgaCapabilityRelationV1 {
  const base = capability.replaceAll(".", "_");
  return {
    allow: `allow_${base}`,
    profile: `profile_${base}`,
    ceiling: `ceiling_${base}`,
  };
}

export function openFgaSubject(subject: AccessBindingSubjectV1) {
  return objectName(subject.kind, authorizationSubjectName(subject));
}

export function openFgaProfile(
  fleet: string,
  profile: Pick<AccessProfileVersionV1, "profileId" | "profileVersion">,
) {
  return objectName(
    "access_profile",
    `fleet:${fleet}/profile:${profile.profileId}@v${profile.profileVersion}`,
  );
}

export function openFgaCeiling(
  fleet: string,
  ceiling: Pick<AccessCeilingV1, "ceilingId" | "revision">,
) {
  return objectName(
    "access_ceiling",
    `fleet:${fleet}/ceiling:${ceiling.ceilingId}@r${ceiling.revision}`,
  );
}

export function openFgaTarget(
  fleet: string,
  permission: AccessPermissionV1,
) {
  const canonical = [
    `fleet:${fleet}`,
    authorizationResourceName(permission.resource),
    `environment:${permission.environment ?? "-"}`,
  ].join("|");
  return objectName("authorization_target", canonical);
}

interface CompileOpenFgaAuthorizationStateInput {
  readonly ceiling: AccessCeilingV1;
  readonly profile: AccessProfileVersionV1;
  readonly binding: AccessBindingV1;
}

export const compileOpenFgaAuthorizationState = Effect.fn(
  "agentos.openfga.compileAuthorizationState",
)(function*(input: CompileOpenFgaAuthorizationStateInput) {
  const ceiling = yield* decodeAccessCeiling(input.ceiling);
  const profile = yield* decodeAccessProfileVersion(input.profile);
  const binding = yield* decodeAccessBinding(input.binding);
  if (
    binding.profile.profileId !== profile.profileId ||
    binding.profile.profileVersion !== profile.profileVersion
  ) {
    return yield* compileError("binding_profile_mismatch", "binding.profile");
  }
  if (binding.issuedUnderCeiling.ceilingId !== ceiling.ceilingId) {
    return yield* compileError("ceiling_id_mismatch", "binding.ceiling");
  }
  if (binding.issuedUnderCeiling.revision > ceiling.revision) {
    return yield* compileError(
      "issued_revision_ahead",
      "binding.ceiling.revision",
    );
  }
  if (!ceilingContainsSubject(ceiling, binding.subject)) {
    return yield* compileError(
      "subject_outside_ceiling",
      "binding.subject",
    );
  }

  const fleetName = binding.subject.fleet;
  const fleet = objectName("fleet", `fleet:${fleetName}`);
  const domain = objectName(
    "domain",
    `fleet:${fleetName}/domain:${binding.subject.domain}`,
  );
  const subject = openFgaSubject(binding.subject);
  const profileObject = openFgaProfile(fleetName, profile);
  const ceilingObject = openFgaCeiling(fleetName, ceiling);
  const tuples: Array<OpenFgaTupleV1> = [
    tuple(domain, "domain", fleet),
    tuple(subject, "member", domain),
  ];

  if (binding.state === "active") {
    tuples.push(tuple(
      subject,
      "subject",
      profileObject,
      yield* activeWindow(
        binding.createdAtMillis,
        binding.expiresAtMillis,
        "binding",
      ),
    ));
    tuples.push(tuple(
      subject,
      "subject",
      ceilingObject,
      yield* activeWindow(
        Math.max(binding.createdAtMillis, ceiling.effectiveAtMillis),
        binding.expiresAtMillis,
        "ceiling_subject",
      ),
    ));
  }

  for (const permission of profile.permissions) {
    if (permission.rateClass === "disabled") continue;
    const target = openFgaTarget(fleetName, permission);
    const relation = openFgaCapabilityRelation(permission.capability);
    tuples.push(tuple(fleet, "fleet", target));
    tuples.push(tuple(
      profileObject,
      relation.profile,
      target,
      yield* activeWindow(0, permission.expiresAtMillis, "profile_permission"),
    ));
  }
  for (const permission of ceiling.permissions) {
    if (permission.rateClass === "disabled") continue;
    const target = openFgaTarget(fleetName, permission);
    const relation = openFgaCapabilityRelation(permission.capability);
    tuples.push(tuple(fleet, "fleet", target));
    tuples.push(tuple(
      ceilingObject,
      relation.ceiling,
      target,
      yield* activeWindow(
        ceiling.effectiveAtMillis,
        permission.expiresAtMillis,
        "ceiling_permission",
      ),
    ));
  }

  if (binding.state === "active") {
    for (const profilePermission of profile.permissions) {
      const ceilingPermission = ceiling.permissions.find((candidate) =>
        permissionKey(candidate) === permissionKey(profilePermission)
      );
      if (
        ceilingPermission === undefined ||
        profilePermission.rateClass === "disabled" ||
        ceilingPermission.rateClass === "disabled" ||
        OpenFgaRateClassRank[profilePermission.rateClass] >
          OpenFgaRateClassRank[ceilingPermission.rateClass]
      ) {
        continue;
      }
      const target = openFgaTarget(fleetName, profilePermission);
      const relation = openFgaCapabilityRelation(profilePermission.capability);
      tuples.push(tuple(
        subject,
        relation.allow,
        target,
        yield* activeWindow(
          Math.max(binding.createdAtMillis, ceiling.effectiveAtMillis),
          minimumExpiry(
            binding.expiresAtMillis,
            profilePermission.expiresAtMillis,
            ceilingPermission.expiresAtMillis,
          ),
          "effective_grant",
        ),
      ));
    }
  }

  return {
    schemaVersion: 1,
    modelVersion: AGENTOS_OPENFGA_MODEL_VERSION,
    fleet: fleetName,
    subject,
    tuples: yield* deduplicateAndSortTuples(tuples),
  } satisfies OpenFgaTuplePlanV1;
});

export const diffOpenFgaTuplePlans = Effect.fn(
  "agentos.openfga.diffTuplePlans",
)(function*(
  previous: OpenFgaTuplePlanV1,
  next: OpenFgaTuplePlanV1,
) {
  const before = new Map(previous.tuples.map((item) => [tupleKey(item), item]));
  const after = new Map(next.tuples.map((item) => [tupleKey(item), item]));
  const writes: Array<OpenFgaTupleV1> = [];
  const deletes: Array<OpenFgaTupleDeleteV1> = [];

  for (const [key, tupleValue] of before) {
    const replacement = after.get(key);
    if (replacement === undefined) {
      deletes.push(deleteTuple(tupleValue));
      continue;
    }
    if (JSON.stringify(tupleValue.condition) !== JSON.stringify(replacement.condition)) {
      return yield* compileError(
        "tuple_replacement_not_atomic",
        "tuple.condition",
      );
    }
  }
  for (const [key, tupleValue] of after) {
    if (!before.has(key)) writes.push(tupleValue);
  }
  return {
    writes: sortTuples(writes),
    deletes: deletes.sort(compareTupleParts),
  } satisfies OpenFgaTupleMutationV1;
});

function objectName(type: string, id: string) {
  return `${type}:${encodeURIComponent(id)}`;
}

function tuple(
  user: string,
  relation: string,
  object: string,
  condition: OpenFgaActiveWindowConditionV1 | null = null,
): OpenFgaTupleV1 {
  return { user, relation, object, condition };
}

function deleteTuple(value: OpenFgaTupleV1): OpenFgaTupleDeleteV1 {
  return {
    user: value.user,
    relation: value.relation,
    object: value.object,
  };
}

const activeWindow = Effect.fn("agentos.openfga.activeWindow")(
  function*(
    effectiveAtMillis: number,
    expiresAtMillis: number | null,
    boundary: string,
  ) {
    return {
      name: "active_window",
      context: {
        effective_at: yield* timestamp(effectiveAtMillis, boundary),
        expires_at: expiresAtMillis === null
          ? AGENTOS_OPENFGA_NO_EXPIRY
          : yield* timestamp(expiresAtMillis, boundary),
      },
    } satisfies OpenFgaActiveWindowConditionV1;
  },
);

function timestamp(value: number, boundary: string) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Date.parse(AGENTOS_OPENFGA_NO_EXPIRY)
  ) {
    return Effect.fail(compileError("timestamp_out_of_range", boundary));
  }
  return Effect.succeed(new Date(value).toISOString());
}

function ceilingContainsSubject(
  ceiling: AccessCeilingV1,
  subject: AccessBindingSubjectV1,
) {
  return ceiling.scope.fleet === subject.fleet &&
    (ceiling.scope.kind === "fleet" ||
      ceiling.scope.domain === subject.domain);
}

function permissionKey(permission: AccessPermissionV1) {
  return [
    permission.capability,
    authorizationResourceName(permission.resource),
    permission.environment ?? "-",
  ].join("\u0000");
}

function minimumExpiry(...values: ReadonlyArray<number | null>) {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length === 0 ? null : Math.min(...finite);
}

function compileError(
  code: OpenFgaPolicyCompileError["code"],
  boundary: string,
) {
  return OpenFgaPolicyCompileError.make({ code, boundary });
}

function tupleKey(value: OpenFgaTupleV1 | OpenFgaTupleDeleteV1) {
  return `${value.object}\u0000${value.relation}\u0000${value.user}`;
}

function compareTupleParts(
  left: OpenFgaTupleV1 | OpenFgaTupleDeleteV1,
  right: OpenFgaTupleV1 | OpenFgaTupleDeleteV1,
) {
  return tupleKey(left).localeCompare(tupleKey(right));
}

function sortTuples(values: Array<OpenFgaTupleV1>) {
  return values.sort(compareTupleParts);
}

function deduplicateAndSortTuples(values: Array<OpenFgaTupleV1>) {
  const unique = new Map<string, OpenFgaTupleV1>();
  for (const value of values) {
    const key = tupleKey(value);
    const existing = unique.get(key);
    if (
      existing !== undefined &&
      JSON.stringify(existing.condition) !== JSON.stringify(value.condition)
    ) {
      return Effect.fail(
        compileError("tuple_replacement_not_atomic", "tuple.condition"),
      );
    }
    unique.set(key, value);
  }
  return Effect.succeed(sortTuples([...unique.values()]));
}

function deepFreeze<A>(value: A): A {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
