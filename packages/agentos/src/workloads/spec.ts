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
const AgentName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/),
  ),
);
const AbsoluteDistributionRoot = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/),
  ),
);
const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);
const KubernetesQuantity = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(32),
    Schema.isPattern(/^[0-9]+(?:m|Mi|Gi)?$/),
  ),
);
const DatabaseIdentity = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^runtime_[a-z0-9_]+$/),
  ),
);
const ProviderAccessProfileReference = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^[a-z][a-z0-9-]{0,62}@v[1-9][0-9]*$/),
  ),
);
const NonBlankString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      expected: "a non-blank string",
    }),
  ),
);

export const AgentWorkloadProfileNameSchema = Schema.Literals([
  "persistent-mate",
  "interactive-crewmate",
]);

const ResourceQuantityPair = Schema.Struct({
  cpu: KubernetesQuantity,
  memory: KubernetesQuantity,
});
const ContainerResources = Schema.Struct({
  requests: ResourceQuantityPair,
  limits: ResourceQuantityPair,
});
const Toleration = Schema.Struct({
  effect: Schema.NullOr(
    Schema.Literals(["NoExecute", "NoSchedule", "PreferNoSchedule"]),
  ),
  key: NonBlankString,
  operator: Schema.Literals(["Equal", "Exists"]),
  value: Schema.NullOr(Schema.String),
});

export const AgentWorkloadSpecV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  distributionRoot: AbsoluteDistributionRoot,
  overlayRoot: AbsoluteDistributionRoot,
  profile: Schema.Struct({
    name: AgentWorkloadProfileNameSchema,
    version: Schema.Literal(1),
  }),
  fleet: KubernetesName,
  namespace: KubernetesName,
  identity: Schema.Struct({
    agentId: Uuid,
    ownerAgentId: Uuid,
    taskId: Schema.NullOr(Uuid),
    assignmentId: Schema.NullOr(Uuid),
    role: Schema.Literals(["second_mate", "crewmate"]),
    agentName: AgentName,
  }),
  names: Schema.Struct({
    workload: KubernetesName,
    service: KubernetesName,
    serviceAccount: KubernetesName,
    herdrSession: KubernetesName,
  }),
  ownerServiceAccount: Schema.Struct({
    name: KubernetesName,
    namespace: KubernetesName,
  }),
  image: Schema.Struct({
    reference: NonBlankString,
    pullPolicy: Schema.Literals(["Always", "IfNotPresent"]),
  }),
  harness: Schema.Literals(["pi", "codex"]),
  home: Schema.Struct({
    accessMode: Schema.Literal("ReadWriteOnce"),
    retention: Schema.Literal("Retain"),
    size: KubernetesQuantity,
    storageClassName: KubernetesName,
  }),
  resources: Schema.Struct({
    agent: ContainerResources,
    init: ContainerResources,
  }),
  scheduling: Schema.Struct({
    nodeSelector: Schema.Record(Schema.String, Schema.String),
    tolerations: Schema.Array(Toleration),
  }),
  database: Schema.Struct({
    identity: DatabaseIdentity,
    url: NonBlankString,
    secret: Schema.Struct({
      key: Schema.Literal("pgpass"),
      name: KubernetesName,
    }),
  }),
  providerAccessProfiles: Schema.Array(ProviderAccessProfileReference),
  brief: Schema.NullOr(
    Schema.Struct({
      path: Schema.Literal("/home/agent/brief.md"),
      sha256: Sha256,
    }),
  ),
  readiness: Schema.Struct({
    contract: Schema.Literal("semantic-v1"),
  }),
  protocols: Schema.Struct({
    a2a: Schema.NullOr(Schema.Literal("v1")),
    acp: Schema.NullOr(Schema.Literal("v1")),
  }),
});

const AgentWorkloadSpecErrorCode = Schema.Literals([
  "duplicate_reference",
  "invalid_field",
  "invalid_relationship",
  "literal_credential",
  "mutable_image",
  "resource_limit",
  "serialization_failed",
  "unsupported_profile",
]);

export class AgentWorkloadSpecError extends Schema.TaggedErrorClass<AgentWorkloadSpecError>()(
  "AgentWorkloadSpecError",
  {
    code: AgentWorkloadSpecErrorCode,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentWorkloadSpecV1 = typeof AgentWorkloadSpecV1Schema.Type;
export type AgentWorkloadProfileName = typeof AgentWorkloadProfileNameSchema.Type;

export function workloadSpecError(
  code: AgentWorkloadSpecError["code"],
  field: string,
  message: string,
) {
  return AgentWorkloadSpecError.make({ code, field, message });
}

export const decodeAgentWorkloadSpec = Effect.fn(
  "agentos.workloadSpec.decode",
)(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(AgentWorkloadSpecV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError((error) => {
      const safe = contractError("agent_workload_spec", error.issue);
      return workloadSpecError(
        safe.path.startsWith("$.profile")
          ? "unsupported_profile"
          : "invalid_field",
        safe.path,
        `Invalid AgentWorkloadSpec field ${safe.path}`,
      );
    }),
  );
});
