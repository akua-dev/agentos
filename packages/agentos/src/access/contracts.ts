import { Effect, Schema } from "effect";

import { contractError } from "../shared/errors.ts";

const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const ProviderName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
  ),
);
const GitHubOwner = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(39),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const GitHubRepository = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(100), Schema.isPattern(/^[a-z0-9._-]+$/)),
);
const AccessProfileId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(63), Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
);
const PositiveInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const CeilingId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ceiling_[0-9a-f]{32}$/)),
);
const BindingId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^binding_[0-9a-f]{32}$/)),
);
const AuditEventId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^authz_[0-9a-f]{32}$/)),
);
const CorrelationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^corr_[0-9a-f]{32}$/)),
);

const AgentSkillId = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9._-]*@v[1-9][0-9]*$/),
  ),
);

export const AccessProviderIdSchema = Schema.Literals([
  "agentos",
  "github",
  "openai",
]);
export const AccessRateClassIdSchema = Schema.Literals([
  "disabled",
  "low",
  "standard",
  "high",
]);
export const AccessCapabilityIdSchema = Schema.Literals([
  "agentos.a2a.send",
  "github.actions.dispatch",
  "github.actions.read",
  "github.contents.write",
  "github.issue.read",
  "github.issue.write",
  "github.project.read",
  "github.project.write",
  "github.pull_request.read",
  "github.pull_request.write",
  "github.repository.read",
  "openai.models.read",
  "openai.responses.compact",
  "openai.responses.create",
  "provider.secret.use",
]);

const FleetSubjectV1Schema = Schema.Struct({
  kind: Schema.Literal("fleet"),
  fleet: KubernetesName,
});
const DomainSubjectV1Schema = Schema.Struct({
  kind: Schema.Literal("domain"),
  fleet: KubernetesName,
  domain: KubernetesName,
});
const MateSubjectV1Schema = Schema.Struct({
  kind: Schema.Literal("mate"),
  fleet: KubernetesName,
  domain: KubernetesName,
  agentId: Uuid,
});
const AssignmentSubjectV1Schema = Schema.Struct({
  kind: Schema.Literal("assignment"),
  fleet: KubernetesName,
  domain: KubernetesName,
  assignmentId: Uuid,
});

export const AuthorizationSubjectV1Schema = Schema.Union([
  FleetSubjectV1Schema,
  DomainSubjectV1Schema,
  MateSubjectV1Schema,
  AssignmentSubjectV1Schema,
]);

export const AccessBindingSubjectV1Schema = Schema.Union([
  MateSubjectV1Schema,
  AssignmentSubjectV1Schema,
]);

export const AccessCeilingScopeV1Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fleet"), fleet: KubernetesName }),
  Schema.Struct({
    kind: Schema.Literal("domain"),
    fleet: KubernetesName,
    domain: KubernetesName,
  }),
]);

export const AuthorizationResourceV1Schema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent_skill"),
    targetAgentId: Uuid,
    skillId: AgentSkillId,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider_service"),
    provider: AccessProviderIdSchema,
    service: ProviderName,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider_account"),
    provider: AccessProviderIdSchema,
    account: ProviderName,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider_adapter"),
    provider: AccessProviderIdSchema,
    adapter: ProviderName,
  }),
  Schema.Struct({
    kind: Schema.Literal("github_repository"),
    owner: GitHubOwner,
    repository: GitHubRepository,
  }),
  Schema.Struct({
    kind: Schema.Literal("github_project"),
    organization: GitHubOwner,
    projectNumber: PositiveInt,
  }),
]);

export const AccessPermissionV1Schema = Schema.Struct({
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  environment: Schema.NullOr(KubernetesName),
  expiresAtMillis: Schema.NullOr(EpochMillis),
  rateClass: AccessRateClassIdSchema,
});

export const AccessCeilingRefV1Schema = Schema.Struct({
  ceilingId: CeilingId,
  revision: PositiveInt,
});

export const AccessProfileRefV1Schema = Schema.Struct({
  profileId: AccessProfileId,
  profileVersion: PositiveInt,
});

export const AccessCeilingV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ceilingId: CeilingId,
  revision: PositiveInt,
  supersedesRevision: Schema.NullOr(PositiveInt),
  owner: Schema.Struct({
    authority: Schema.Literal("captain-platform"),
    captainId: Uuid,
  }),
  scope: AccessCeilingScopeV1Schema,
  effectiveAtMillis: EpochMillis,
  permissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
});

export const AccessProfileVersionV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  compatibility: Schema.Literal("agentos-access-v1"),
  profileId: AccessProfileId,
  profileVersion: PositiveInt,
  previousProfileVersion: Schema.NullOr(PositiveInt),
  publishedBy: Schema.Literal("first-mate-control-plane"),
  permissions: Schema.NonEmptyArray(AccessPermissionV1Schema),
});

export const AccessBindingV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bindingId: BindingId,
  profile: AccessProfileRefV1Schema,
  subject: AccessBindingSubjectV1Schema,
  issuedUnderCeiling: AccessCeilingRefV1Schema,
  createdAtMillis: EpochMillis,
  expiresAtMillis: Schema.NullOr(EpochMillis),
  state: Schema.Literals(["active", "revoked"]),
});

export const AccessDecisionReasonV1Schema = Schema.Literals([
  "allowed",
  "binding_expired",
  "binding_revoked",
  "ceiling_denied",
  "ceiling_expired",
  "ceiling_not_effective",
  "profile_denied",
  "profile_expired",
  "profile_version_mismatch",
  "rate_class_disabled",
  "rate_class_exceeded",
  "subject_mismatch",
  "subject_outside_ceiling",
]);

export const AccessDecisionV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decision: Schema.Literals(["allow", "deny"]),
  reason: AccessDecisionReasonV1Schema,
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  environment: Schema.NullOr(KubernetesName),
  subject: AuthorizationSubjectV1Schema,
  profile: AccessProfileRefV1Schema,
  ceiling: AccessCeilingRefV1Schema,
  rateClass: Schema.NullOr(AccessRateClassIdSchema),
});

const AccessAuditBaseFields = {
  schemaVersion: Schema.Literal(1),
  eventId: AuditEventId,
  timestampMillis: EpochMillis,
  actor: Schema.Struct({
    agentId: Uuid,
    serviceAccountUid: Uuid,
  }),
  correlationId: CorrelationId,
};

export const AccessAuditEventV1Schema = Schema.Union([
  Schema.Struct({
    ...AccessAuditBaseFields,
    kind: Schema.Literal("access_evaluated"),
    subject: AccessBindingSubjectV1Schema,
    profile: AccessProfileRefV1Schema,
    bindingId: BindingId,
    ceiling: AccessCeilingRefV1Schema,
    capability: AccessCapabilityIdSchema,
    resource: AuthorizationResourceV1Schema,
    environment: Schema.NullOr(KubernetesName),
    decision: Schema.Literals(["allow", "deny"]),
    reason: AccessDecisionReasonV1Schema,
  }),
  Schema.Struct({
    ...AccessAuditBaseFields,
    kind: Schema.Literal("profile_published"),
    target: AccessCeilingScopeV1Schema,
    profile: AccessProfileRefV1Schema,
    previousProfile: Schema.NullOr(AccessProfileRefV1Schema),
    ceiling: AccessCeilingRefV1Schema,
    decision: Schema.Literal("recorded"),
    reason: Schema.Literal("profile_published"),
  }),
  Schema.Struct({
    ...AccessAuditBaseFields,
    kind: Schema.Literal("binding_created"),
    subject: AccessBindingSubjectV1Schema,
    profile: AccessProfileRefV1Schema,
    bindingId: BindingId,
    ceiling: AccessCeilingRefV1Schema,
    decision: Schema.Literal("recorded"),
    reason: Schema.Literal("binding_created"),
  }),
  Schema.Struct({
    ...AccessAuditBaseFields,
    kind: Schema.Literal("binding_revoked"),
    subject: AccessBindingSubjectV1Schema,
    profile: AccessProfileRefV1Schema,
    bindingId: BindingId,
    ceiling: AccessCeilingRefV1Schema,
    decision: Schema.Literal("recorded"),
    reason: Schema.Literal("binding_revoked"),
  }),
]);

const AccessContractErrorCodeSchema = Schema.Literals([
  "ambiguous_version",
  "duplicate_permission",
  "invalid_field",
  "invalid_relationship",
  "resource_mismatch",
]);

export class AccessContractError extends Schema.TaggedErrorClass<AccessContractError>()(
  "AccessContractError",
  {
    code: AccessContractErrorCodeSchema,
    boundary: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type AccessProviderId = typeof AccessProviderIdSchema.Type;
export type AccessRateClassId = typeof AccessRateClassIdSchema.Type;
export type AccessCapabilityId = typeof AccessCapabilityIdSchema.Type;
export type AuthorizationSubjectV1 = typeof AuthorizationSubjectV1Schema.Type;
export type AccessBindingSubjectV1 = typeof AccessBindingSubjectV1Schema.Type;
export type AccessCeilingScopeV1 = typeof AccessCeilingScopeV1Schema.Type;
export type AuthorizationResourceV1 = typeof AuthorizationResourceV1Schema.Type;
export type AccessPermissionV1 = typeof AccessPermissionV1Schema.Type;
export type AccessCeilingRefV1 = typeof AccessCeilingRefV1Schema.Type;
export type AccessProfileRefV1 = typeof AccessProfileRefV1Schema.Type;
export type AccessCeilingV1 = typeof AccessCeilingV1Schema.Type;
export type AccessProfileVersionV1 = typeof AccessProfileVersionV1Schema.Type;
export type AccessBindingV1 = typeof AccessBindingV1Schema.Type;
export type AccessDecisionV1 = typeof AccessDecisionV1Schema.Type;
export type AccessDecisionReasonV1 = typeof AccessDecisionReasonV1Schema.Type;
export type AccessAuditEventV1 = typeof AccessAuditEventV1Schema.Type;

export interface AccessCapabilityDefinitionV1 {
  readonly id: AccessCapabilityId;
  readonly provider: AccessProviderId | "provider-adapter";
  readonly action:
    | "a2a_send"
    | "actions_dispatch"
    | "actions_read"
    | "contents_write"
    | "issue_read"
    | "issue_write"
    | "models_read"
    | "project_read"
    | "project_write"
    | "pull_request_read"
    | "pull_request_write"
    | "repository_read"
    | "responses_compact"
    | "responses_create"
    | "secret_use";
  readonly resourceKinds: ReadonlyArray<AuthorizationResourceV1["kind"]>;
  readonly registryAuthority: "captain-platform";
  readonly grantAuthority: "first-mate-within-ceiling";
}

function capability(
  definition: AccessCapabilityDefinitionV1,
): AccessCapabilityDefinitionV1 {
  return Object.freeze({
    ...definition,
    resourceKinds: Object.freeze([...definition.resourceKinds]),
  });
}

export const accessCapabilitiesV1: ReadonlyArray<AccessCapabilityDefinitionV1> =
  Object.freeze([
    capability({
      id: "agentos.a2a.send",
      provider: "agentos",
      action: "a2a_send",
      resourceKinds: ["agent_skill"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.actions.dispatch",
      provider: "github",
      action: "actions_dispatch",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.actions.read",
      provider: "github",
      action: "actions_read",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.contents.write",
      provider: "github",
      action: "contents_write",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.issue.read",
      provider: "github",
      action: "issue_read",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.issue.write",
      provider: "github",
      action: "issue_write",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.project.read",
      provider: "github",
      action: "project_read",
      resourceKinds: ["github_project"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.project.write",
      provider: "github",
      action: "project_write",
      resourceKinds: ["github_project"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.pull_request.read",
      provider: "github",
      action: "pull_request_read",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.pull_request.write",
      provider: "github",
      action: "pull_request_write",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "github.repository.read",
      provider: "github",
      action: "repository_read",
      resourceKinds: ["github_repository"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "openai.models.read",
      provider: "openai",
      action: "models_read",
      resourceKinds: ["provider_service", "provider_account"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "openai.responses.compact",
      provider: "openai",
      action: "responses_compact",
      resourceKinds: ["provider_service", "provider_account"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "openai.responses.create",
      provider: "openai",
      action: "responses_create",
      resourceKinds: ["provider_service", "provider_account"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
    capability({
      id: "provider.secret.use",
      provider: "provider-adapter",
      action: "secret_use",
      resourceKinds: ["provider_adapter"],
      registryAuthority: "captain-platform",
      grantAuthority: "first-mate-within-ceiling",
    }),
  ]);

const rateClassRank: Readonly<Record<AccessRateClassId, number>> =
  Object.freeze({
    disabled: 0,
    low: 1,
    standard: 2,
    high: 3,
  });

function accessContractError(
  code: AccessContractError["code"],
  boundary: string,
  field: string,
  message: string,
) {
  return AccessContractError.make({ code, boundary, field, message });
}

function decodeError(
  boundary: string,
  issue: Parameters<typeof contractError>[1],
) {
  const safe = contractError(boundary, issue);
  return accessContractError(
    "invalid_field",
    boundary,
    safe.path,
    `Invalid AgentOS ${boundary} at ${safe.path}`,
  );
}

export function authorizationSubjectName(subject: AuthorizationSubjectV1) {
  switch (subject.kind) {
    case "fleet":
      return `fleet:${subject.fleet}`;
    case "domain":
      return `fleet:${subject.fleet}/domain:${subject.domain}`;
    case "mate":
      return `fleet:${subject.fleet}/domain:${subject.domain}/mate:${subject.agentId}`;
    case "assignment":
      return `fleet:${subject.fleet}/domain:${subject.domain}/assignment:${subject.assignmentId}`;
  }
}

export function authorizationResourceName(resource: AuthorizationResourceV1) {
  switch (resource.kind) {
    case "agent_skill":
      return `agent:${resource.targetAgentId}/skill:${resource.skillId}`;
    case "provider_service":
      return `provider:${resource.provider}/service:${resource.service}`;
    case "provider_account":
      return `provider:${resource.provider}/account:${resource.account}`;
    case "provider_adapter":
      return `provider:${resource.provider}/adapter:${resource.adapter}`;
    case "github_repository":
      return `github:repository:${resource.owner}/${resource.repository}`;
    case "github_project":
      return `github:project:${resource.organization}/${resource.projectNumber}`;
  }
}

function permissionBoundary(permission: AccessPermissionV1) {
  return `${permission.capability}|${authorizationResourceName(permission.resource)}|${permission.environment ?? "-"}`;
}

function validatePermission(
  permission: AccessPermissionV1,
  boundary: string,
  field: string,
) {
  const definition = accessCapabilitiesV1.find(
    ({ id }) => id === permission.capability,
  );
  if (
    definition === undefined ||
    !definition.resourceKinds.includes(permission.resource.kind)
  ) {
    return Effect.fail(
      accessContractError(
        "resource_mismatch",
        boundary,
        `${field}.resource`,
        `Capability ${permission.capability} cannot target ${permission.resource.kind}`,
      ),
    );
  }
  if (
    definition.provider !== "provider-adapter" &&
    (permission.resource.kind === "provider_service" ||
      permission.resource.kind === "provider_account" ||
      permission.resource.kind === "provider_adapter") &&
    permission.resource.provider !== definition.provider
  ) {
    return Effect.fail(
      accessContractError(
        "resource_mismatch",
        boundary,
        `${field}.resource.provider`,
        `Capability ${permission.capability} cannot target provider ${permission.resource.provider}`,
      ),
    );
  }
  return Effect.void;
}

const validatePermissions = Effect.fn("agentos.access.validatePermissions")(
  function* (
    permissions: ReadonlyArray<AccessPermissionV1>,
    boundary: string,
    field: string,
  ) {
    const seen = new Set<string>();
    for (const [index, permission] of permissions.entries()) {
      yield* validatePermission(permission, boundary, `${field}[${index}]`);
      const key = permissionBoundary(permission);
      if (seen.has(key)) {
        return yield* Effect.fail(
          accessContractError(
            "duplicate_permission",
            boundary,
            `${field}[${index}]`,
            "A capability/resource/environment permission may appear only once",
          ),
        );
      }
      seen.add(key);
    }
  },
);

export const decodeAccessCeiling = Effect.fn("agentos.access.decodeCeiling")(
  function* (input: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(AccessCeilingV1Schema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError((error) => decodeError("access_ceiling", error.issue)),
    );
    const expectedPrevious =
      decoded.revision === 1 ? null : decoded.revision - 1;
    if (decoded.supersedesRevision !== expectedPrevious) {
      return yield* Effect.fail(
        accessContractError(
          "ambiguous_version",
          "access_ceiling",
          "$.supersedesRevision",
          "Ceiling revisions must form one contiguous immutable chain",
        ),
      );
    }
    yield* validatePermissions(
      decoded.permissions,
      "access_ceiling",
      "$.permissions",
    );
    for (const [index, permission] of decoded.permissions.entries()) {
      if (
        permission.expiresAtMillis !== null &&
        permission.expiresAtMillis <= decoded.effectiveAtMillis
      ) {
        return yield* Effect.fail(
          accessContractError(
            "invalid_relationship",
            "access_ceiling",
            `$.permissions[${index}].expiresAtMillis`,
            "A ceiling permission must remain valid after the ceiling becomes effective",
          ),
        );
      }
    }
    return decoded;
  },
);

export const decodeAccessProfileVersion = Effect.fn(
  "agentos.access.decodeProfileVersion",
)(function* (input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(
    AccessProfileVersionV1Schema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError((error) =>
      decodeError("access_profile_version", error.issue),
    ),
  );
  const expectedPrevious =
    decoded.profileVersion === 1 ? null : decoded.profileVersion - 1;
  if (decoded.previousProfileVersion !== expectedPrevious) {
    return yield* Effect.fail(
      accessContractError(
        "ambiguous_version",
        "access_profile_version",
        "$.previousProfileVersion",
        "Profile versions must form one contiguous immutable chain",
      ),
    );
  }
  yield* validatePermissions(
    decoded.permissions,
    "access_profile_version",
    "$.permissions",
  );
  return decoded;
});

export const decodeAccessBinding = Effect.fn("agentos.access.decodeBinding")(
  function* (input: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(AccessBindingV1Schema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError((error) => decodeError("access_binding", error.issue)),
    );
    if (
      decoded.expiresAtMillis !== null &&
      decoded.expiresAtMillis <= decoded.createdAtMillis
    ) {
      return yield* Effect.fail(
        accessContractError(
          "invalid_relationship",
          "access_binding",
          "$.expiresAtMillis",
          "A binding must expire after it is created",
        ),
      );
    }
    return decoded;
  },
);

export const decodeAccessAuditEvent = Effect.fn(
  "agentos.access.decodeAuditEvent",
)(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(AccessAuditEventV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError((error) => decodeError("access_audit_event", error.issue)),
  );
});

function sameResource(
  left: AuthorizationResourceV1,
  right: AuthorizationResourceV1,
) {
  return authorizationResourceName(left) === authorizationResourceName(right);
}

function permissionMatches(
  permission: AccessPermissionV1,
  capabilityId: AccessCapabilityId,
  resource: AuthorizationResourceV1,
  environment: string | null,
) {
  return (
    permission.capability === capabilityId &&
    sameResource(permission.resource, resource) &&
    permission.environment === environment
  );
}

function scopeContains(
  scope: AccessCeilingScopeV1,
  subject: AuthorizationSubjectV1,
) {
  if (scope.fleet !== subject.fleet) return false;
  if (scope.kind === "fleet") return true;
  return subject.kind !== "fleet" && scope.domain === subject.domain;
}

interface AccessRequestEvaluationInput {
  readonly atMillis: number;
  readonly subject: AuthorizationSubjectV1;
  readonly ceiling: AccessCeilingV1;
  readonly profile: AccessProfileVersionV1;
  readonly binding: AccessBindingV1;
  readonly capability: AccessCapabilityId;
  readonly resource: AuthorizationResourceV1;
  readonly environment: string | null;
}

export const evaluateAccessRequest = Effect.fn(
  "agentos.access.evaluateRequest",
)(function* (input: AccessRequestEvaluationInput) {
  const base: Omit<AccessDecisionV1, "decision" | "rateClass" | "reason"> = {
    schemaVersion: 1,
    capability: input.capability,
    resource: input.resource,
    environment: input.environment,
    subject: input.subject,
    profile: {
      profileId: input.profile.profileId,
      profileVersion: input.profile.profileVersion,
    },
    ceiling: {
      ceilingId: input.ceiling.ceilingId,
      revision: input.ceiling.revision,
    },
  };
  const deny = (
    reason: Exclude<AccessDecisionV1["reason"], "allowed">,
  ): AccessDecisionV1 => ({
    ...base,
    decision: "deny",
    reason,
    rateClass: null,
  });

  if (input.binding.state === "revoked") return deny("binding_revoked");
  if (
    input.binding.expiresAtMillis !== null &&
    input.binding.expiresAtMillis <= input.atMillis
  ) {
    return deny("binding_expired");
  }
  if (
    input.binding.profile.profileId !== input.profile.profileId ||
    input.binding.profile.profileVersion !== input.profile.profileVersion
  ) {
    return deny("profile_version_mismatch");
  }
  if (
    authorizationSubjectName(input.binding.subject) !==
    authorizationSubjectName(input.subject)
  ) {
    return deny("subject_mismatch");
  }
  if (!scopeContains(input.ceiling.scope, input.subject)) {
    return deny("subject_outside_ceiling");
  }
  if (input.ceiling.effectiveAtMillis > input.atMillis) {
    return deny("ceiling_not_effective");
  }

  const profilePermission = input.profile.permissions.find((permission) =>
    permissionMatches(
      permission,
      input.capability,
      input.resource,
      input.environment,
    ),
  );
  if (profilePermission === undefined) return deny("profile_denied");
  if (
    profilePermission.expiresAtMillis !== null &&
    profilePermission.expiresAtMillis <= input.atMillis
  ) {
    return deny("profile_expired");
  }

  const ceilingPermission = input.ceiling.permissions.find((permission) =>
    permissionMatches(
      permission,
      input.capability,
      input.resource,
      input.environment,
    ),
  );
  if (ceilingPermission === undefined) return deny("ceiling_denied");
  if (
    ceilingPermission.expiresAtMillis !== null &&
    ceilingPermission.expiresAtMillis <= input.atMillis
  ) {
    return deny("ceiling_expired");
  }
  if (
    profilePermission.rateClass === "disabled" ||
    ceilingPermission.rateClass === "disabled"
  ) {
    return deny("rate_class_disabled");
  }
  if (
    rateClassRank[profilePermission.rateClass] >
    rateClassRank[ceilingPermission.rateClass]
  ) {
    return deny("rate_class_exceeded");
  }

  return {
    ...base,
    decision: "allow",
    reason: "allowed",
    rateClass: profilePermission.rateClass,
  } satisfies AccessDecisionV1;
});
