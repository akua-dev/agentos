import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";

import { contractError } from "../shared/errors.ts";

const KubernetesQuantity = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(32),
    Schema.isPattern(/^[0-9]+(?:m|Mi|Gi)?$/),
  ),
);
const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);

export const AgentWorkloadProfileIdSchema = Schema.Literals([
  "persistent-mate@v1",
  "interactive-crewmate@v1",
  "stateless-job@v1",
]);
export const AgentWorkloadRequirementNameSchema = Schema.Literals([
  "persistence",
  "nativeAttach",
  "resume",
  "followUp",
  "retainedWorktree",
  "retainedDeliveryState",
  "longLivedServiceIdentity",
]);

const ResourceQuantityPairSchema = Schema.Struct({
  cpu: KubernetesQuantity,
  memory: KubernetesQuantity,
});
const ContainerResourceDefaultsSchema = Schema.Struct({
  requests: ResourceQuantityPairSchema,
  limits: ResourceQuantityPairSchema,
});

export const AgentWorkloadResourceDefaultsV1Schema = Schema.Struct({
  homeSize: Schema.NullOr(KubernetesQuantity),
  resources: Schema.Struct({
    agent: ContainerResourceDefaultsSchema,
    init: ContainerResourceDefaultsSchema,
  }),
});

export const AgentWorkloadProfileMechanicsV1Schema = Schema.Struct({
  dedicatedServiceAccount: Schema.Boolean,
  retainedHome: Schema.Boolean,
  podLocalHerdr: Schema.Boolean,
  stableWorkload: Schema.Boolean,
  oneWriter: Schema.Boolean,
  projectedSupervisionIdentity: Schema.Boolean,
  longLivedServiceIdentity: Schema.Boolean,
});

export const AgentWorkloadDispatchRequirementsV1Schema = Schema.Struct({
  persistence: Schema.Boolean,
  nativeAttach: Schema.Boolean,
  resume: Schema.Boolean,
  followUp: Schema.Boolean,
  retainedWorktree: Schema.Boolean,
  retainedDeliveryState: Schema.Boolean,
  longLivedServiceIdentity: Schema.Boolean,
});

const AgentWorkloadProfileContractV1Schema = Schema.Struct({
  id: AgentWorkloadProfileIdSchema,
  name: Schema.Literals([
    "persistent-mate",
    "interactive-crewmate",
    "stateless-job",
  ]),
  version: Schema.Literal(1),
  compilerAvailability: Schema.Literals(["released", "future"]),
  kustomizeBase: Schema.NullOr(Schema.String),
  mainContainerName: Schema.NullOr(Schema.String),
  mechanics: AgentWorkloadProfileMechanicsV1Schema,
  defaults: AgentWorkloadResourceDefaultsV1Schema,
  resourceKinds: Schema.Array(Schema.String),
});

export const AgentWorkloadProfileDefinitionV1Schema = Schema.Struct({
  ...AgentWorkloadProfileContractV1Schema.fields,
  definitionDigest: Sha256,
});

export const AgentWorkloadProfileSelectionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  profileId: AgentWorkloadProfileIdSchema,
  requirements: AgentWorkloadDispatchRequirementsV1Schema,
  domainDefaults: Schema.NullOr(AgentWorkloadResourceDefaultsV1Schema),
});

export const AgentWorkloadProfileResolutionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  profile: AgentWorkloadProfileDefinitionV1Schema,
  requirements: AgentWorkloadDispatchRequirementsV1Schema,
  defaults: AgentWorkloadResourceDefaultsV1Schema,
  domainDefaultsApplied: Schema.Boolean,
  satisfiedRequirements: Schema.Array(AgentWorkloadRequirementNameSchema),
  selectionAuthority: Schema.Literal("assignment-dispatch"),
});

const AgentWorkloadProfileErrorCodeSchema = Schema.Literals([
  "defaults_widened",
  "incompatible_requirement",
  "invalid_defaults",
  "invalid_field",
  "resource_limit",
  "unsupported_profile",
]);

export class AgentWorkloadProfileError extends Schema.TaggedErrorClass<AgentWorkloadProfileError>()(
  "AgentWorkloadProfileError",
  {
    code: AgentWorkloadProfileErrorCodeSchema,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentWorkloadProfileId = typeof AgentWorkloadProfileIdSchema.Type;
export type AgentWorkloadRequirementName =
  typeof AgentWorkloadRequirementNameSchema.Type;
export type AgentWorkloadResourceDefaultsV1 =
  typeof AgentWorkloadResourceDefaultsV1Schema.Type;
export type AgentWorkloadProfileDefinitionV1 =
  typeof AgentWorkloadProfileDefinitionV1Schema.Type;
export type AgentWorkloadProfileSelectionV1 =
  typeof AgentWorkloadProfileSelectionV1Schema.Type;
export type AgentWorkloadProfileResolutionV1 =
  typeof AgentWorkloadProfileResolutionV1Schema.Type;

type AgentWorkloadProfileContractV1 =
  typeof AgentWorkloadProfileContractV1Schema.Type;
type ContainerResourceDefaults =
  AgentWorkloadResourceDefaultsV1["resources"]["agent"];

const persistentDefaults = freezeDefaults({
  homeSize: "20Gi",
  resources: {
    agent: {
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { cpu: "2", memory: "4Gi" },
    },
    init: {
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
  },
});

const statelessDefaults = freezeDefaults({
  homeSize: null,
  resources: {
    agent: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
    init: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    },
  },
});

const persistentMateProfile = profileDefinition({
  id: "persistent-mate@v1",
  name: "persistent-mate",
  version: 1,
  compilerAvailability: "released",
  kustomizeBase: "resources/roles/secondmate/kubernetes/domain",
  mainContainerName: "agentos",
  mechanics: {
    dedicatedServiceAccount: true,
    retainedHome: true,
    podLocalHerdr: true,
    stableWorkload: true,
    oneWriter: true,
    projectedSupervisionIdentity: true,
    longLivedServiceIdentity: true,
  },
  defaults: persistentDefaults,
  resourceKinds: [
    "LimitRange",
    "Namespace",
    "NetworkPolicy",
    "PersistentVolumeClaim",
    "ResourceQuota",
    "Role",
    "RoleBinding",
    "Service",
    "ServiceAccount",
    "StatefulSet",
  ],
});

const interactiveCrewmateProfile = profileDefinition({
  id: "interactive-crewmate@v1",
  name: "interactive-crewmate",
  version: 1,
  compilerAvailability: "released",
  kustomizeBase: "resources/crewmates/default/kubernetes/base",
  mainContainerName: "crewmate",
  mechanics: {
    dedicatedServiceAccount: true,
    retainedHome: true,
    podLocalHerdr: true,
    stableWorkload: true,
    oneWriter: true,
    projectedSupervisionIdentity: false,
    longLivedServiceIdentity: true,
  },
  defaults: persistentDefaults,
  resourceKinds: [
    "PersistentVolumeClaim",
    "Service",
    "ServiceAccount",
    "StatefulSet",
  ],
});

const statelessJobProfile = profileDefinition({
  id: "stateless-job@v1",
  name: "stateless-job",
  version: 1,
  compilerAvailability: "future",
  kustomizeBase: null,
  mainContainerName: null,
  mechanics: {
    dedicatedServiceAccount: true,
    retainedHome: false,
    podLocalHerdr: false,
    stableWorkload: false,
    oneWriter: false,
    projectedSupervisionIdentity: false,
    longLivedServiceIdentity: false,
  },
  defaults: statelessDefaults,
  resourceKinds: ["Job", "ServiceAccount"],
});

export const agentWorkloadProfilesV1 = Object.freeze([
  persistentMateProfile,
  interactiveCrewmateProfile,
  statelessJobProfile,
]);

export function getAgentWorkloadProfile(
  id: AgentWorkloadProfileId,
): AgentWorkloadProfileDefinitionV1 {
  switch (id) {
    case "persistent-mate@v1":
      return persistentMateProfile;
    case "interactive-crewmate@v1":
      return interactiveCrewmateProfile;
    case "stateless-job@v1":
      return statelessJobProfile;
  }
}

export function agentWorkloadProfileId(profile: {
  readonly name:
    | "persistent-mate"
    | "interactive-crewmate"
    | "stateless-job";
  readonly version: 1;
}): AgentWorkloadProfileId {
  switch (profile.name) {
    case "persistent-mate":
      return "persistent-mate@v1";
    case "interactive-crewmate":
      return "interactive-crewmate@v1";
    case "stateless-job":
      return "stateless-job@v1";
  }
}

export const decodeAgentWorkloadProfileSelection = Effect.fn(
  "agentos.workloadProfile.decodeSelection",
)(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(AgentWorkloadProfileSelectionV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError((error) => {
      const safe = contractError("agent_workload_profile_selection", error.issue);
      return profileError(
        safe.path === "$.profileId"
          ? "unsupported_profile"
          : "invalid_field",
        safe.path,
        safe.path === "$.profileId"
          ? "Agent workload profile identifier is unsupported"
          : `Invalid Agent workload profile field ${safe.path}`,
      );
    }),
  );
});

export const resolveAgentWorkloadProfile = Effect.fn(
  "agentos.workloadProfile.resolve",
)(function*(input: unknown) {
  const selection = yield* decodeAgentWorkloadProfileSelection(input);
  const profile = getAgentWorkloadProfile(selection.profileId);
  const satisfiedRequirements = yield* validateRequirements(
    selection.requirements,
    profile,
  );
  const defaults = yield* normalizeDomainDefaults(
    selection.domainDefaults ?? profile.defaults,
    profile,
  );

  return {
    version: 1,
    profile,
    requirements: selection.requirements,
    defaults,
    domainDefaultsApplied: selection.domainDefaults !== null,
    satisfiedRequirements,
    selectionAuthority: "assignment-dispatch",
  } satisfies AgentWorkloadProfileResolutionV1;
});

function profileDefinition(
  contract: AgentWorkloadProfileContractV1,
): AgentWorkloadProfileDefinitionV1 {
  const mechanics = Object.freeze({ ...contract.mechanics });
  const resourceKinds = Object.freeze([...contract.resourceKinds]);
  const canonical = JSON.stringify({
    ...contract,
    mechanics,
    resourceKinds,
  });
  return Object.freeze({
    ...contract,
    mechanics,
    resourceKinds,
    definitionDigest: sha256(canonical),
  });
}

function freezeDefaults(
  defaults: AgentWorkloadResourceDefaultsV1,
): AgentWorkloadResourceDefaultsV1 {
  return Object.freeze({
    homeSize: defaults.homeSize,
    resources: Object.freeze({
      agent: freezeContainerDefaults(defaults.resources.agent),
      init: freezeContainerDefaults(defaults.resources.init),
    }),
  });
}

function freezeContainerDefaults(
  defaults: ContainerResourceDefaults,
): ContainerResourceDefaults {
  return Object.freeze({
    requests: Object.freeze({ ...defaults.requests }),
    limits: Object.freeze({ ...defaults.limits }),
  });
}

const requirementOrder: ReadonlyArray<AgentWorkloadRequirementName> = [
  "persistence",
  "nativeAttach",
  "resume",
  "followUp",
  "retainedWorktree",
  "retainedDeliveryState",
  "longLivedServiceIdentity",
];

const validateRequirements = Effect.fn(
  "agentos.workloadProfile.validateRequirements",
)(function*(
  requirements: AgentWorkloadProfileSelectionV1["requirements"],
  profile: AgentWorkloadProfileDefinitionV1,
) {
  const satisfied: AgentWorkloadRequirementName[] = [];
  for (const requirement of requirementOrder) {
    if (!requirements[requirement]) continue;
    if (!supportsRequirement(profile, requirement)) {
      return yield* profileError(
        "incompatible_requirement",
        `$.requirements.${requirement}`,
        `Selected workload profile does not support ${requirement}`,
      );
    }
    satisfied.push(requirement);
  }
  return satisfied;
});

function supportsRequirement(
  profile: AgentWorkloadProfileDefinitionV1,
  requirement: AgentWorkloadRequirementName,
): boolean {
  switch (requirement) {
    case "persistence":
    case "retainedWorktree":
    case "retainedDeliveryState":
      return profile.mechanics.retainedHome;
    case "nativeAttach":
    case "followUp":
      return profile.mechanics.podLocalHerdr && profile.mechanics.stableWorkload;
    case "resume":
      return profile.mechanics.retainedHome &&
        profile.mechanics.stableWorkload && profile.mechanics.oneWriter;
    case "longLivedServiceIdentity":
      return profile.mechanics.longLivedServiceIdentity;
  }
}

const normalizeDomainDefaults = Effect.fn(
  "agentos.workloadProfile.normalizeDomainDefaults",
)(function*(
  defaults: AgentWorkloadResourceDefaultsV1,
  profile: AgentWorkloadProfileDefinitionV1,
) {
  if (profile.defaults.homeSize === null) {
    if (defaults.homeSize !== null) {
      return yield* profileError(
        "invalid_defaults",
        "$.domainDefaults.homeSize",
        "Stateless workload profiles cannot select persistent home storage",
      );
    }
  } else if (defaults.homeSize === null) {
    return yield* profileError(
      "invalid_defaults",
      "$.domainDefaults.homeSize",
      "Persistent workload profiles require a home storage default",
    );
  }

  const homeSize = defaults.homeSize === null
    ? null
    : yield* normalizeStorageDefault(
      defaults.homeSize,
      profile.defaults.homeSize,
      "$.domainDefaults.homeSize",
    );
  const resources = {
    agent: yield* normalizeContainerDefaults(
      defaults.resources.agent,
      profile.defaults.resources.agent,
      "$.domainDefaults.resources.agent",
    ),
    init: yield* normalizeContainerDefaults(
      defaults.resources.init,
      profile.defaults.resources.init,
      "$.domainDefaults.resources.init",
    ),
  };
  return freezeDefaults({ homeSize, resources });
});

const normalizeContainerDefaults = Effect.fn(
  "agentos.workloadProfile.normalizeContainerDefaults",
)(function*(
  defaults: ContainerResourceDefaults,
  baseline: ContainerResourceDefaults,
  field: string,
) {
  const requestCpu = yield* cpuQuantity(
    defaults.requests.cpu,
    `${field}.requests.cpu`,
  );
  const limitCpu = yield* cpuQuantity(
    defaults.limits.cpu,
    `${field}.limits.cpu`,
  );
  const requestMemory = yield* memoryQuantity(
    defaults.requests.memory,
    `${field}.requests.memory`,
  );
  const limitMemory = yield* memoryQuantity(
    defaults.limits.memory,
    `${field}.limits.memory`,
  );
  yield* validateGlobalBounds(requestCpu, 25, 4_000, `${field}.requests.cpu`);
  yield* validateGlobalBounds(limitCpu, 25, 4_000, `${field}.limits.cpu`);
  yield* validateGlobalBounds(
    requestMemory,
    64,
    8 * 1_024,
    `${field}.requests.memory`,
  );
  yield* validateGlobalBounds(
    limitMemory,
    64,
    8 * 1_024,
    `${field}.limits.memory`,
  );
  if (limitCpu < requestCpu) {
    return yield* profileError(
      "invalid_defaults",
      `${field}.limits.cpu`,
      "Workload profile CPU limit cannot be below its request",
    );
  }
  if (limitMemory < requestMemory) {
    return yield* profileError(
      "invalid_defaults",
      `${field}.limits.memory`,
      "Workload profile memory limit cannot be below its request",
    );
  }

  yield* rejectWidening(
    requestCpu,
    yield* cpuQuantity(baseline.requests.cpu, `${field}.requests.cpu`),
    `${field}.requests.cpu`,
  );
  yield* rejectWidening(
    limitCpu,
    yield* cpuQuantity(baseline.limits.cpu, `${field}.limits.cpu`),
    `${field}.limits.cpu`,
  );
  yield* rejectWidening(
    requestMemory,
    yield* memoryQuantity(baseline.requests.memory, `${field}.requests.memory`),
    `${field}.requests.memory`,
  );
  yield* rejectWidening(
    limitMemory,
    yield* memoryQuantity(baseline.limits.memory, `${field}.limits.memory`),
    `${field}.limits.memory`,
  );

  return freezeContainerDefaults({
    requests: {
      cpu: formatCpu(requestCpu),
      memory: formatMi(requestMemory),
    },
    limits: {
      cpu: formatCpu(limitCpu),
      memory: formatMi(limitMemory),
    },
  });
});

const normalizeStorageDefault = Effect.fn(
  "agentos.workloadProfile.normalizeStorageDefault",
)(function*(value: string, baseline: string | null, field: string) {
  if (baseline === null) {
    return yield* profileError(
      "invalid_defaults",
      field,
      "Stateless workload profiles cannot select persistent home storage",
    );
  }
  const selectedMi = yield* memoryQuantity(value, field);
  yield* validateGlobalBounds(selectedMi, 1_024, 40 * 1_024, field);
  const baselineMi = yield* memoryQuantity(baseline, field);
  yield* rejectWidening(selectedMi, baselineMi, field);
  return formatMi(selectedMi);
});

function validateGlobalBounds(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
) {
  return value < minimum || value > maximum
    ? Effect.fail(profileError(
      "resource_limit",
      field,
      `Workload profile resource is outside the released ceiling at ${field}`,
    ))
    : Effect.void;
}

function rejectWidening(value: number, baseline: number, field: string) {
  return value > baseline
    ? Effect.fail(profileError(
      "defaults_widened",
      field,
      `Domain workload default widens the immutable profile at ${field}`,
    ))
    : Effect.void;
}

const cpuQuantity = Effect.fn("agentos.workloadProfile.cpuQuantity")(function*(
  value: string,
  field: string,
) {
  const milli = /^(\d+)m$/.exec(value)?.[1];
  const cores = /^(\d+)$/.exec(value)?.[1];
  const parsed = milli === undefined
    ? cores === undefined
      ? undefined
      : Number(cores) * 1_000
    : Number(milli);
  if (parsed === undefined || !Number.isSafeInteger(parsed)) {
    return yield* profileError(
      "invalid_defaults",
      field,
      `Workload profile CPU default is invalid at ${field}`,
    );
  }
  return parsed;
});

const memoryQuantity = Effect.fn(
  "agentos.workloadProfile.memoryQuantity",
)(function*(value: string, field: string) {
  const match = /^(\d+)(Mi|Gi)$/.exec(value);
  const amount = match?.[1] === undefined ? undefined : Number(match[1]);
  if (amount === undefined || !Number.isSafeInteger(amount)) {
    return yield* profileError(
      "invalid_defaults",
      field,
      `Workload profile memory default is invalid at ${field}`,
    );
  }
  return match?.[2] === "Gi" ? amount * 1_024 : amount;
});

function formatCpu(millis: number): string {
  return millis % 1_000 === 0 ? String(millis / 1_000) : `${millis}m`;
}

function formatMi(mebibytes: number): string {
  return mebibytes % 1_024 === 0
    ? `${mebibytes / 1_024}Gi`
    : `${mebibytes}Mi`;
}

function profileError(
  code: AgentWorkloadProfileError["code"],
  field: string,
  message: string,
) {
  return AgentWorkloadProfileError.make({ code, field, message });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
