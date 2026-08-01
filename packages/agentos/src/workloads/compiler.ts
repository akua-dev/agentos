import { createHash } from "node:crypto";
import { relative } from "node:path/posix";
import { Effect, Schema } from "effect";
import { stringify } from "yaml";

import {
  AgentWorkloadSpecError,
  AgentWorkloadSpecV1Schema,
  decodeAgentWorkloadSpec,
  workloadSpecError,
  type AgentWorkloadSpecV1,
} from "./spec.ts";

export { AgentWorkloadSpecError } from "./spec.ts";

const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);
const ResourceQuantityPair = Schema.Struct({
  cpu: Schema.String,
  memory: Schema.String,
});

export const AgentWorkloadPlanSummaryV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  specVersion: Schema.Literal(1),
  specDigest: Sha256,
  overlayDigest: Sha256,
  profile: AgentWorkloadSpecV1Schema.fields.profile,
  agentId: Schema.String,
  ownerAgentId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  assignmentId: Schema.NullOr(Schema.String),
  fleet: Schema.String,
  namespace: Schema.String,
  workload: Schema.String,
  service: Schema.String,
  serviceAccount: Schema.String,
  homeClaim: Schema.String,
  harness: Schema.String,
  imageDigest: Sha256,
  pullPolicy: Schema.String,
  storageClassName: Schema.String,
  storageSize: Schema.String,
  resources: Schema.Struct({
    agent: Schema.Struct({
      requests: ResourceQuantityPair,
      limits: ResourceQuantityPair,
    }),
    init: Schema.Struct({
      requests: ResourceQuantityPair,
      limits: ResourceQuantityPair,
    }),
  }),
  databaseIdentity: Schema.String,
  databaseSecret: Schema.String,
  providerAccessProfiles: Schema.Array(Schema.String),
  readinessContract: Schema.String,
  protocols: AgentWorkloadSpecV1Schema.fields.protocols,
  resourceKinds: Schema.Array(Schema.String),
});

export const AgentWorkloadOverlayFileV1Schema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  sha256: Sha256,
});

export const AgentWorkloadPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  spec: AgentWorkloadSpecV1Schema,
  specDigest: Sha256,
  overlayDigest: Sha256,
  files: Schema.Array(AgentWorkloadOverlayFileV1Schema),
  summary: AgentWorkloadPlanSummaryV1Schema,
});

export type AgentWorkloadPlanV1 = typeof AgentWorkloadPlanV1Schema.Type;
export type AgentWorkloadPlanSummaryV1 =
  typeof AgentWorkloadPlanSummaryV1Schema.Type;

type ContainerResources = AgentWorkloadSpecV1["resources"]["agent"];
type Toleration = AgentWorkloadSpecV1["scheduling"]["tolerations"][number];

const maximumCpuMillis = 4_000;
const minimumCpuMillis = 25;
const maximumMemoryMi = 8 * 1_024;
const minimumMemoryMi = 64;
const maximumStorageMi = 40 * 1_024;
const minimumStorageMi = 1_024;

const immutableImagePattern =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)+(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)@sha256:([0-9a-f]{64})$/;
const labelKeyPattern =
  /^(?:(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?)\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const labelValuePattern =
  /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

export const compileAgentWorkloadSpec = Effect.fn(
  "agentos.workloadSpec.compile",
)(function*(input: unknown) {
  const decoded = yield* decodeAgentWorkloadSpec(input);
  const normalized = yield* validateAndNormalize(decoded);
  const canonicalSpec = yield* Schema.encodeEffect(
    Schema.fromJsonString(AgentWorkloadSpecV1Schema),
  )(normalized).pipe(
    Effect.mapError(() =>
      workloadSpecError(
        "serialization_failed",
        "$",
        "Validated AgentWorkloadSpec could not be serialized",
      ),
    ),
  );
  const specDigest = sha256(canonicalSpec);
  const imageDigest = immutableImagePattern.exec(normalized.image.reference)?.[1];
  if (imageDigest === undefined) {
    return yield* workloadSpecError(
      "mutable_image",
      "$.image.reference",
      "Agent workload image must use an immutable sha256 digest",
    );
  }

  const patchDefinitions = workloadPatches(normalized);
  const patchFiles = yield* Effect.forEach(
    patchDefinitions,
    ({ path, value }) => yamlFile(path, value),
  );
  const kustomization = yield* yamlFile(
    "kustomization.yaml",
    workloadKustomization(normalized, patchDefinitions),
  );
  const files = [...patchFiles, kustomization].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const overlayDigest = sha256(
    files.map(({ path, content }) => `${path}\u0000${content}`).join("\u0000"),
  );
  const summary = workloadSummary(
    normalized,
    imageDigest,
    specDigest,
    overlayDigest,
  );

  return {
    version: 1,
    spec: normalized,
    specDigest,
    overlayDigest,
    files,
    summary,
  } satisfies AgentWorkloadPlanV1;
});

const validateAndNormalize = Effect.fn(
  "agentos.workloadSpec.validate",
)(function*(spec: AgentWorkloadSpecV1) {
  if (spec.identity.agentId === spec.identity.ownerAgentId) {
    return yield* workloadSpecError(
      "invalid_relationship",
      "$.identity.ownerAgentId",
      "Agent and owner identities must be distinct",
    );
  }
  if (
    spec.ownerServiceAccount.namespace === spec.namespace &&
    spec.ownerServiceAccount.name === spec.names.serviceAccount
  ) {
    return yield* workloadSpecError(
      "invalid_relationship",
      "$.names.serviceAccount",
      "Agent workloads require a dedicated ServiceAccount",
    );
  }
  yield* validateProfileRelationships(spec);

  const imageMatch = immutableImagePattern.exec(spec.image.reference);
  if (imageMatch === null) {
    return yield* workloadSpecError(
      "mutable_image",
      "$.image.reference",
      "Agent workload image must use an immutable sha256 digest",
    );
  }

  const databaseUrl = yield* normalizeDatabaseUrl(spec);
  const resources = {
    agent: yield* normalizeContainerResources(
      spec.resources.agent,
      "$.resources.agent",
    ),
    init: yield* normalizeContainerResources(
      spec.resources.init,
      "$.resources.init",
    ),
  };
  const storageSize = yield* normalizeStorage(spec.home.size);
  const scheduling = yield* normalizeScheduling(spec);
  const providerAccessProfiles = yield* normalizeProfileReferences(
    spec.providerAccessProfiles,
  );

  return {
    ...spec,
    database: { ...spec.database, url: databaseUrl },
    home: { ...spec.home, size: storageSize },
    resources,
    scheduling,
    providerAccessProfiles,
  } satisfies AgentWorkloadSpecV1;
});

const validateProfileRelationships = Effect.fn(
  "agentos.workloadSpec.validateProfile",
)(function*(spec: AgentWorkloadSpecV1) {
  if (spec.profile.name === "persistent-mate") {
    if (spec.identity.role !== "second_mate") {
      return yield* relationshipError("$.identity.role");
    }
    if (spec.harness !== "pi") {
      return yield* relationshipError("$.harness");
    }
    if (spec.identity.taskId !== null) {
      return yield* relationshipError("$.identity.taskId");
    }
    if (spec.identity.assignmentId !== null) {
      return yield* relationshipError("$.identity.assignmentId");
    }
    if (spec.brief !== null) {
      return yield* relationshipError("$.brief");
    }
    return;
  }

  if (spec.identity.role !== "crewmate") {
    return yield* relationshipError("$.identity.role");
  }
  if (spec.identity.taskId === null) {
    return yield* relationshipError("$.identity.taskId");
  }
  if (spec.identity.assignmentId === null) {
    return yield* relationshipError("$.identity.assignmentId");
  }
  if (spec.brief === null) {
    return yield* relationshipError("$.brief");
  }
  if (spec.ownerServiceAccount.namespace !== spec.namespace) {
    return yield* relationshipError("$.ownerServiceAccount.namespace");
  }
});

function relationshipError(field: string) {
  return workloadSpecError(
    "invalid_relationship",
    field,
    `Agent workload relationship is inconsistent at ${field}`,
  );
}

const normalizeDatabaseUrl = Effect.fn(
  "agentos.workloadSpec.databaseUrl",
)(function*(spec: AgentWorkloadSpecV1) {
  const url = yield* Effect.try({
    try: () => new URL(spec.database.url),
    catch: () =>
      workloadSpecError(
        "invalid_field",
        "$.database.url",
        "Agent workload database URL is invalid",
      ),
  });
  if (url.password.length > 0) {
    return yield* workloadSpecError(
      "literal_credential",
      "$.database.url",
      "Agent workload database URL cannot contain a credential",
    );
  }
  if (
    url.protocol !== "postgresql:" ||
    url.username !== spec.database.identity ||
    url.hostname.length === 0 ||
    url.pathname !== "/agentos" ||
    url.hash.length > 0
  ) {
    return yield* workloadSpecError(
      "invalid_relationship",
      "$.database.url",
      "Agent workload database reference is inconsistent",
    );
  }
  const queryEntries = [...url.searchParams.entries()];
  if (
    queryEntries.length !== 1 ||
    queryEntries[0]?.[0] !== "sslmode" ||
    !["require", "verify-full"].includes(queryEntries[0]?.[1] ?? "")
  ) {
    return yield* workloadSpecError(
      "invalid_field",
      "$.database.url",
      "Agent workload database URL requires one approved TLS mode",
    );
  }
  return url.toString();
});

const normalizeContainerResources = Effect.fn(
  "agentos.workloadSpec.containerResources",
)(function*(resources: ContainerResources, field: string) {
  const requestCpu = yield* cpuQuantity(
    resources.requests.cpu,
    `${field}.requests.cpu`,
  );
  const limitCpu = yield* cpuQuantity(
    resources.limits.cpu,
    `${field}.limits.cpu`,
  );
  const requestMemory = yield* memoryQuantity(
    resources.requests.memory,
    `${field}.requests.memory`,
  );
  const limitMemory = yield* memoryQuantity(
    resources.limits.memory,
    `${field}.limits.memory`,
  );
  if (requestCpu < minimumCpuMillis || requestCpu > maximumCpuMillis) {
    return yield* resourceError(`${field}.requests.cpu`);
  }
  if (
    limitCpu < requestCpu ||
    limitCpu < minimumCpuMillis ||
    limitCpu > maximumCpuMillis
  ) {
    return yield* resourceError(`${field}.limits.cpu`);
  }
  if (requestMemory < minimumMemoryMi || requestMemory > maximumMemoryMi) {
    return yield* resourceError(`${field}.requests.memory`);
  }
  if (
    limitMemory < requestMemory ||
    limitMemory < minimumMemoryMi ||
    limitMemory > maximumMemoryMi
  ) {
    return yield* resourceError(`${field}.limits.memory`);
  }
  return {
    requests: {
      cpu: formatCpu(requestCpu),
      memory: formatMi(requestMemory),
    },
    limits: {
      cpu: formatCpu(limitCpu),
      memory: formatMi(limitMemory),
    },
  } satisfies ContainerResources;
});

const cpuQuantity = Effect.fn("agentos.workloadSpec.cpuQuantity")(function*(
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
    return yield* resourceError(field);
  }
  return parsed;
});

const memoryQuantity = Effect.fn(
  "agentos.workloadSpec.memoryQuantity",
)(function*(value: string, field: string) {
  const match = /^(\d+)(Mi|Gi)$/.exec(value);
  const amount = match?.[1] === undefined ? undefined : Number(match[1]);
  if (amount === undefined || !Number.isSafeInteger(amount)) {
    return yield* resourceError(field);
  }
  return match?.[2] === "Gi" ? amount * 1_024 : amount;
});

const normalizeStorage = Effect.fn(
  "agentos.workloadSpec.storageQuantity",
)(function*(value: string) {
  const storageMi = yield* memoryQuantity(value, "$.home.size");
  if (storageMi < minimumStorageMi || storageMi > maximumStorageMi) {
    return yield* resourceError("$.home.size");
  }
  return formatMi(storageMi);
});

function resourceError(field: string) {
  return workloadSpecError(
    "resource_limit",
    field,
    `Agent workload resource is outside the released ceiling at ${field}`,
  );
}

function formatCpu(millis: number): string {
  return millis % 1_000 === 0 ? String(millis / 1_000) : `${millis}m`;
}

function formatMi(mebibytes: number): string {
  return mebibytes % 1_024 === 0
    ? `${mebibytes / 1_024}Gi`
    : `${mebibytes}Mi`;
}

const normalizeScheduling = Effect.fn(
  "agentos.workloadSpec.scheduling",
)(function*(spec: AgentWorkloadSpecV1) {
  const nodeSelectorEntries = Object.entries(spec.scheduling.nodeSelector).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [key, value] of nodeSelectorEntries) {
    if (
      key.length > 317 ||
      value.length > 63 ||
      !labelKeyPattern.test(key) ||
      !labelValuePattern.test(value)
    ) {
      return yield* workloadSpecError(
        "invalid_field",
        "$.scheduling.nodeSelector",
        "Agent workload node selector contains an invalid label",
      );
    }
  }

  const tolerations = [...spec.scheduling.tolerations].sort((left, right) =>
    tolerationKey(left).localeCompare(tolerationKey(right)),
  );
  const seen = new Set<string>();
  for (const toleration of tolerations) {
    const key = tolerationKey(toleration);
    if (seen.has(key)) {
      return yield* workloadSpecError(
        "duplicate_reference",
        "$.scheduling.tolerations",
        "Agent workload tolerations must be unique",
      );
    }
    seen.add(key);
    if (
      toleration.key.length > 317 ||
      !labelKeyPattern.test(toleration.key) ||
      (toleration.value !== null &&
        (toleration.value.length > 63 ||
          !labelValuePattern.test(toleration.value))) ||
      (toleration.operator === "Exists" && toleration.value !== null) ||
      (toleration.operator === "Equal" && toleration.value === null)
    ) {
      return yield* workloadSpecError(
        "invalid_field",
        "$.scheduling.tolerations",
        "Agent workload toleration is invalid",
      );
    }
  }

  return {
    nodeSelector: Object.fromEntries(nodeSelectorEntries),
    tolerations,
  } satisfies AgentWorkloadSpecV1["scheduling"];
});

function tolerationKey(toleration: Toleration): string {
  return [
    toleration.key,
    toleration.operator,
    toleration.value ?? "",
    toleration.effect ?? "",
  ].join("\u0000");
}

const normalizeProfileReferences = Effect.fn(
  "agentos.workloadSpec.profileReferences",
)(function*(references: ReadonlyArray<string>) {
  const sorted = [...references].sort();
  if (new Set(sorted).size !== sorted.length) {
    return yield* workloadSpecError(
      "duplicate_reference",
      "$.providerAccessProfiles",
      "Provider access profile references must be unique",
    );
  }
  return sorted;
});

interface PatchDefinition {
  readonly path: string;
  readonly value: unknown;
  readonly target: {
    readonly group?: string;
    readonly version: string;
    readonly kind: string;
    readonly name: string;
  };
}

function workloadPatches(
  spec: AgentWorkloadSpecV1,
): ReadonlyArray<PatchDefinition> {
  const persistent = spec.profile.name === "persistent-mate";
  const baseWorkload = persistent ? "agentos-secondmate" : "agentos-crewmate";
  const workloadTarget = {
    group: "apps",
    version: "v1",
    kind: "StatefulSet",
    name: baseWorkload,
  };
  const serviceTarget = {
    version: "v1",
    kind: "Service",
    name: baseWorkload,
  };
  const serviceAccountTarget = {
    version: "v1",
    kind: "ServiceAccount",
    name: baseWorkload,
  };
  const common: ReadonlyArray<PatchDefinition> = [
    {
      path: "workload.patch.yaml",
      value: workloadPatch(spec, baseWorkload),
      target: workloadTarget,
    },
    {
      path: "workload-name.patch.yaml",
      value: renamePatch(spec.names.workload),
      target: workloadTarget,
    },
    {
      path: "service.patch.yaml",
      value: servicePatch(spec, baseWorkload),
      target: serviceTarget,
    },
    {
      path: "service-name.patch.yaml",
      value: renamePatch(spec.names.service),
      target: serviceTarget,
    },
    {
      path: "serviceaccount.patch.yaml",
      value: serviceAccountPatch(spec, baseWorkload),
      target: serviceAccountTarget,
    },
    {
      path: "serviceaccount-name.patch.yaml",
      value: renamePatch(spec.names.serviceAccount),
      target: serviceAccountTarget,
    },
  ];
  if (!persistent) return common;
  return [
    ...common,
    {
      path: "namespace.patch.yaml",
      value: namespacePatch(spec),
      target: {
        version: "v1",
        kind: "Namespace",
        name: "agentos-secondmate-domain",
      },
    },
    {
      path: "namespace-name.patch.yaml",
      value: renamePatch(spec.namespace),
      target: {
        version: "v1",
        kind: "Namespace",
        name: "agentos-secondmate-domain",
      },
    },
    {
      path: "owner-rolebinding.patch.yaml",
      value: roleBindingPatch(
        "agentos-firstmate-domain-supervisor-binding",
        spec.ownerServiceAccount.name,
        spec.ownerServiceAccount.namespace,
      ),
      target: {
        group: "rbac.authorization.k8s.io",
        version: "v1",
        kind: "RoleBinding",
        name: "agentos-firstmate-domain-supervisor-binding",
      },
    },
    {
      path: "workload-rolebinding.patch.yaml",
      value: roleBindingPatch(
        "agentos-secondmate-workload-manager-binding",
        spec.names.serviceAccount,
        spec.namespace,
      ),
      target: {
        group: "rbac.authorization.k8s.io",
        version: "v1",
        kind: "RoleBinding",
        name: "agentos-secondmate-workload-manager-binding",
      },
    },
  ];
}

function workloadKustomization(
  spec: AgentWorkloadSpecV1,
  patches: ReadonlyArray<PatchDefinition>,
) {
  const base = spec.profile.name === "persistent-mate"
    ? `${spec.distributionRoot}/resources/roles/secondmate/kubernetes/domain`
    : `${spec.distributionRoot}/resources/crewmates/default/kubernetes/base`;
  return {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: spec.namespace,
    resources: [relative(spec.overlayRoot, base)],
    patches: patches.map(({ path, target }) => ({ path, target })),
  };
}

function workloadPatch(spec: AgentWorkloadSpecV1, baseName: string) {
  const persistent = spec.profile.name === "persistent-mate";
  const labels = workloadLabels(spec);
  const annotations = workloadAnnotations(spec);
  const environment = workloadEnvironment(spec);
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name: baseName, labels },
    spec: {
      replicas: 1,
      serviceName: spec.names.service,
      persistentVolumeClaimRetentionPolicy: {
        whenDeleted: "Retain",
        whenScaled: "Retain",
      },
      selector: {
        matchLabels: { "app.kubernetes.io/name": spec.names.workload },
      },
      template: {
        metadata: { annotations, labels },
        spec: {
          automountServiceAccountToken: persistent,
          serviceAccountName: spec.names.serviceAccount,
          nodeSelector: spec.scheduling.nodeSelector,
          tolerations: spec.scheduling.tolerations,
          initContainers: [
            containerPatch(
              "install-tools",
              spec,
              spec.resources.init,
              environment,
            ),
            containerPatch(
              "prepare-home",
              spec,
              spec.resources.init,
              environment,
            ),
          ],
          containers: [
            containerPatch(
              persistent ? "agentos" : "crewmate",
              spec,
              spec.resources.agent,
              environment,
            ),
          ],
          volumes: [
            {
              name: "database-credentials",
              secret: {
                defaultMode: 288,
                secretName: spec.database.secret.name,
                items: [
                  { key: spec.database.secret.key, path: "pgpass" },
                ],
              },
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "home" },
          spec: {
            accessModes: [spec.home.accessMode],
            storageClassName: spec.home.storageClassName,
            resources: { requests: { storage: spec.home.size } },
          },
        },
      ],
    },
  };
}

function containerPatch(
  name: string,
  spec: AgentWorkloadSpecV1,
  resources: ContainerResources,
  environment: Readonly<Record<string, string>>,
) {
  const runtimeArgs = name === "agentos" || name === "crewmate"
    ? { args: ["server", "--session", spec.names.herdrSession] }
    : {};
  return {
    name,
    ...runtimeArgs,
    image: spec.image.reference,
    imagePullPolicy: spec.image.pullPolicy,
    env: Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([environmentName, value]) => ({
        name: environmentName,
        value,
      })),
    resources,
  };
}

function workloadEnvironment(
  spec: AgentWorkloadSpecV1,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    AGENTOS_AGENT_ID: spec.identity.agentId,
    AGENTOS_AGENT_NAME: spec.identity.agentName,
    AGENTOS_AGENT_ROLE: spec.identity.role,
    AGENTOS_AI_RUNTIME: spec.harness,
    AGENTOS_DATABASE_IDENTITY: spec.database.identity,
    AGENTOS_DATABASE_URL: spec.database.url,
    AGENTOS_HARNESS: spec.harness,
    AGENTOS_PROVIDER_ACCESS_PROFILES: spec.providerAccessProfiles.join(","),
    HERDR_SESSION: spec.names.herdrSession,
  };
  if (spec.identity.taskId !== null) {
    environment.AGENTOS_TASK_ID = spec.identity.taskId;
  }
  if (spec.identity.assignmentId !== null) {
    environment.AGENTOS_ASSIGNMENT_ID = spec.identity.assignmentId;
  }
  if (spec.brief !== null) {
    environment.AGENTOS_BRIEF_PATH = spec.brief.path;
    environment.AGENTOS_BRIEF_SHA256 = spec.brief.sha256;
  }
  return environment;
}

function workloadLabels(
  spec: AgentWorkloadSpecV1,
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    "agentos.akua.dev/agent": spec.identity.role === "second_mate"
      ? "secondmate"
      : "crewmate",
    "agentos.akua.dev/agent-id": spec.identity.agentId,
    "agentos.akua.dev/owner-agent-id": spec.identity.ownerAgentId,
    "app.kubernetes.io/name": spec.names.workload,
    "app.kubernetes.io/part-of": "agentos",
  };
  if (spec.identity.taskId !== null) {
    labels["agentos.akua.dev/task-id"] = spec.identity.taskId;
  }
  if (spec.identity.assignmentId !== null) {
    labels["agentos.akua.dev/assignment-id"] = spec.identity.assignmentId;
  }
  return labels;
}

function workloadAnnotations(
  spec: AgentWorkloadSpecV1,
): Readonly<Record<string, string>> {
  const annotations: Record<string, string> = {
    "agentos.akua.dev/herdr-session": spec.names.herdrSession,
    "agentos.akua.dev/readiness-contract": spec.readiness.contract,
    "agentos.akua.dev/workload-profile":
      `${spec.profile.name}.v${spec.profile.version}`,
  };
  if (spec.providerAccessProfiles.length > 0) {
    annotations["agentos.akua.dev/provider-access-profiles"] =
      spec.providerAccessProfiles.join(",");
  }
  if (spec.protocols.acp !== null) {
    annotations["agentos.akua.dev/acp"] = spec.protocols.acp;
  }
  if (spec.protocols.a2a !== null) {
    annotations["agentos.akua.dev/a2a"] = spec.protocols.a2a;
  }
  return annotations;
}

function servicePatch(spec: AgentWorkloadSpecV1, baseName: string) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: baseName,
      labels: {
        "agentos.akua.dev/agent-id": spec.identity.agentId,
        "agentos.akua.dev/owner-agent-id": spec.identity.ownerAgentId,
        "app.kubernetes.io/name": spec.names.workload,
        "app.kubernetes.io/part-of": "agentos",
      },
    },
    spec: {
      clusterIP: "None",
      selector: { "app.kubernetes.io/name": spec.names.workload },
    },
  };
}

function serviceAccountPatch(spec: AgentWorkloadSpecV1, baseName: string) {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    automountServiceAccountToken: spec.profile.name === "persistent-mate",
    metadata: {
      name: baseName,
      labels: {
        "agentos.akua.dev/agent-id": spec.identity.agentId,
        "agentos.akua.dev/owner-agent-id": spec.identity.ownerAgentId,
        "app.kubernetes.io/name": spec.names.workload,
        "app.kubernetes.io/part-of": "agentos",
      },
    },
  };
}

function namespacePatch(spec: AgentWorkloadSpecV1) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: "agentos-secondmate-domain",
      labels: {
        "agentos.akua.dev/fleet": spec.fleet,
        "agentos.akua.dev/owner-agent-id": spec.identity.agentId,
      },
    },
  };
}

function roleBindingPatch(
  name: string,
  serviceAccountName: string,
  namespace: string,
) {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name },
    subjects: [
      {
        kind: "ServiceAccount",
        name: serviceAccountName,
        namespace,
      },
    ],
  };
}

function renamePatch(name: string) {
  return [{ op: "replace", path: "/metadata/name", value: name }];
}

function workloadSummary(
  spec: AgentWorkloadSpecV1,
  imageDigest: string,
  specDigest: string,
  overlayDigest: string,
): AgentWorkloadPlanSummaryV1 {
  return {
    version: 1,
    specVersion: spec.version,
    specDigest,
    overlayDigest,
    profile: spec.profile,
    agentId: spec.identity.agentId,
    ownerAgentId: spec.identity.ownerAgentId,
    taskId: spec.identity.taskId,
    assignmentId: spec.identity.assignmentId,
    fleet: spec.fleet,
    namespace: spec.namespace,
    workload: spec.names.workload,
    service: spec.names.service,
    serviceAccount: spec.names.serviceAccount,
    homeClaim: `home-${spec.names.workload}-0`,
    harness: spec.harness,
    imageDigest,
    pullPolicy: spec.image.pullPolicy,
    storageClassName: spec.home.storageClassName,
    storageSize: spec.home.size,
    resources: spec.resources,
    databaseIdentity: spec.database.identity,
    databaseSecret: spec.database.secret.name,
    providerAccessProfiles: spec.providerAccessProfiles,
    readinessContract: spec.readiness.contract,
    protocols: spec.protocols,
    resourceKinds: spec.profile.name === "persistent-mate"
      ? [
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
        ]
      : [
          "PersistentVolumeClaim",
          "Service",
          "ServiceAccount",
          "StatefulSet",
        ],
  };
}

function yamlFile(path: string, value: unknown) {
  return Effect.try({
    try: () => {
      const content = stringify(value, {
        lineWidth: 0,
        sortMapEntries: true,
      });
      return { path, content, sha256: sha256(content) };
    },
    catch: () =>
      workloadSpecError(
        "serialization_failed",
        "$.files",
        "Agent workload overlay could not be serialized",
      ),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
