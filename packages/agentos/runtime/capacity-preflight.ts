import { Effect, Schema } from "effect";

const StringMap = Schema.Record(Schema.String, Schema.String);
const ResourceVector = Schema.Struct({
  cpu: Schema.String,
  memory: Schema.String,
});
const TaintEffect = Schema.Literals([
  "NoExecute",
  "NoSchedule",
  "PreferNoSchedule",
]);
const Taint = Schema.Struct({
  effect: TaintEffect,
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});
const Toleration = Schema.Struct({
  effect: Schema.NullOr(TaintEffect),
  key: Schema.String,
  operator: Schema.Literals(["Equal", "Exists"]),
  value: Schema.NullOr(Schema.String),
});
const NodeSelectorRequirement = Schema.Struct({
  key: Schema.String,
  operator: Schema.Literals([
    "DoesNotExist",
    "Exists",
    "Gt",
    "In",
    "Lt",
    "NotIn",
  ]),
  values: Schema.Array(Schema.String),
});
const ObservedContainer = Schema.Struct({
  name: Schema.String,
  requests: ResourceVector,
});
const ObservedPod = Schema.Struct({
  containers: Schema.Array(ObservedContainer),
  initContainers: Schema.Array(ObservedContainer),
  name: Schema.String,
  namespace: Schema.String,
  nodeName: Schema.NullOr(Schema.String),
  overhead: ResourceVector,
  persistentVolumeClaimNames: Schema.Array(Schema.String),
  phase: Schema.Literals([
    "Failed",
    "Pending",
    "Running",
    "Succeeded",
    "Unknown",
  ]),
});
const ObservedNode = Schema.Struct({
  allocatable: ResourceVector,
  labels: StringMap,
  name: Schema.String,
  taints: Schema.Array(Taint),
  unschedulable: Schema.Boolean,
});
const ObservedResourceQuota = Schema.Struct({
  hard: StringMap,
  name: Schema.String,
  used: StringMap,
});
const StorageMode = Schema.Literals(["node_local", "portable"]);
const ObservedStorageClass = Schema.Struct({
  allowedTopologies: Schema.Array(Schema.Array(NodeSelectorRequirement)),
  isDefault: Schema.Boolean,
  name: Schema.String,
  provisioner: Schema.String,
  storageMode: StorageMode,
  volumeBindingMode: Schema.NullOr(
    Schema.Literals(["Immediate", "WaitForFirstConsumer"]),
  ),
});
const ObservedPersistentVolumeClaim = Schema.Struct({
  accessModes: Schema.Array(Schema.String),
  name: Schema.String,
  namespace: Schema.String,
  phase: Schema.Literals(["Bound", "Lost", "Pending"]),
  storageClassName: Schema.NullOr(Schema.String),
  volumeName: Schema.NullOr(Schema.String),
});
const ObservedPersistentVolume = Schema.Struct({
  name: Schema.String,
  nodeAffinityTerms: Schema.Array(Schema.Array(NodeSelectorRequirement)),
  storageClassName: Schema.NullOr(Schema.String),
});

export const CapacityPreflightSnapshot = Schema.Struct({
  desired: Schema.Struct({
    cpu: Schema.String,
    memory: Schema.String,
    namespace: Schema.String,
    nodeSelector: StringMap,
    podName: Schema.String,
    retainedPvcName: Schema.NullOr(Schema.String),
    storage: Schema.String,
    storageClassName: Schema.NullOr(Schema.String),
    storageMode: StorageMode,
    tolerations: Schema.Array(Toleration),
    unsupportedSchedulingConstraints: Schema.Boolean,
  }),
  observations: Schema.Struct({
    nodes: Schema.Array(ObservedNode),
    nodesComplete: Schema.Boolean,
    persistentVolumeClaims: Schema.Array(ObservedPersistentVolumeClaim),
    persistentVolumeClaimsComplete: Schema.Boolean,
    persistentVolumes: Schema.Array(ObservedPersistentVolume),
    persistentVolumesComplete: Schema.Boolean,
    pods: Schema.Array(ObservedPod),
    podsComplete: Schema.Boolean,
    resourceQuotas: Schema.Array(ObservedResourceQuota),
    resourceQuotasComplete: Schema.Boolean,
    storageClasses: Schema.Array(ObservedStorageClass),
    storageClassesComplete: Schema.Boolean,
  }),
  version: Schema.Literal(1),
});

const CapacityReasonCode = Schema.Literals([
  "incomplete_observation",
  "invalid_storage_binding_mode",
  "node_capacity_exhausted",
  "node_local_volume_unbound",
  "no_schedulable_node",
  "pending_pod_capacity_race",
  "quota_exhausted",
  "quota_observation_missing",
  "retained_pv_missing",
  "retained_pv_node_conflict",
  "retained_pvc_in_use",
  "retained_pvc_lost",
  "retained_pvc_missing",
  "retained_pvc_pending",
  "storage_class_missing",
  "storage_mode_mismatch",
  "storage_topology_conflict",
  "unsupported_scheduling_constraints",
]);
const CapacityReason = Schema.Struct({
  code: CapacityReasonCode,
  evidence: StringMap,
  message: Schema.String,
});

export const CapacityPreflightResult = Schema.Struct({
  eligibleNodeNames: Schema.Array(Schema.String),
  reasons: Schema.Array(CapacityReason),
  reservation: Schema.Literal(false),
  status: Schema.Literals(["fits", "inconclusive", "provably_blocked"]),
});

export type CapacityPreflightSnapshot = typeof CapacityPreflightSnapshot.Type;
type CapacityPreflightResult = typeof CapacityPreflightResult.Type;
type CapacityReason = typeof CapacityReason.Type;
type CapacityReasonCode = typeof CapacityReasonCode.Type;
type Node = typeof ObservedNode.Type;
type Pod = typeof ObservedPod.Type;
type Requirement = typeof NodeSelectorRequirement.Type;
type Taint = typeof Taint.Type;
type Toleration = typeof Toleration.Type;

export class CapacityPreflightInputError extends Schema.TaggedErrorClass<CapacityPreflightInputError>()(
  "CapacityPreflightInputError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

function inputError(path: string, message: string) {
  return CapacityPreflightInputError.make({ message, path });
}

function reason(
  code: CapacityReasonCode,
  message: string,
  evidence: Readonly<Record<string, string>> = {},
): CapacityReason {
  return { code, evidence, message };
}

function tenTo(power: number): bigint {
  return 10n ** BigInt(power);
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function parseKubernetesQuantity(value: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?((?:[eE][+-]?\d+)|[numkKMGTPE]i?)?$/.exec(
    value,
  );
  if (!match) return undefined;
  const whole = match[1];
  const fraction = match[2] ?? "";
  const suffix = match[3] ?? "";
  if (whole === undefined) return undefined;
  const digits = BigInt(`${whole}${fraction}`);
  let numerator = digits;
  let denominator = tenTo(fraction.length);

  if (suffix.startsWith("e") || suffix.startsWith("E")) {
    const exponent = Number(suffix.slice(1));
    if (!Number.isSafeInteger(exponent) || exponent < -30 || exponent > 30) {
      return undefined;
    }
    const nanoExponent = exponent + 9;
    if (nanoExponent >= 0) numerator *= tenTo(nanoExponent);
    else denominator *= tenTo(-nanoExponent);
    return ceilDivide(numerator, denominator);
  }

  const decimalPowers: Readonly<Record<string, number>> = {
    "": 9,
    E: 27,
    G: 18,
    K: 12,
    M: 15,
    P: 24,
    T: 21,
    k: 12,
    m: 6,
    n: 0,
    u: 3,
  };
  const decimalPower = decimalPowers[suffix];
  if (decimalPower !== undefined) {
    numerator *= tenTo(decimalPower);
    return ceilDivide(numerator, denominator);
  }

  const binaryPowers: Readonly<Record<string, number>> = {
    Ei: 6,
    Gi: 3,
    Ki: 1,
    Mi: 2,
    Pi: 5,
    Ti: 4,
  };
  const binaryPower = binaryPowers[suffix];
  if (binaryPower === undefined) return undefined;
  numerator *= 1024n ** BigInt(binaryPower);
  numerator *= 1_000_000_000n;
  return ceilDivide(numerator, denominator);
}

const quantity = Effect.fn("agentos.capacityPreflight.quantity")(function*(
  path: string,
  value: string,
) {
  const parsed = parseKubernetesQuantity(value);
  if (parsed === undefined) {
    return yield* Effect.fail(
      inputError(path, `${path} is not a valid non-negative Kubernetes quantity`),
    );
  }
  return parsed;
});

function add(
  left: Readonly<{ cpu: bigint; memory: bigint }>,
  right: Readonly<{ cpu: bigint; memory: bigint }>,
) {
  return {
    cpu: left.cpu + right.cpu,
    memory: left.memory + right.memory,
  };
}

function max(
  left: Readonly<{ cpu: bigint; memory: bigint }>,
  right: Readonly<{ cpu: bigint; memory: bigint }>,
) {
  return {
    cpu: left.cpu > right.cpu ? left.cpu : right.cpu,
    memory: left.memory > right.memory ? left.memory : right.memory,
  };
}

const podRequest = Effect.fn("agentos.capacityPreflight.podRequest")(
  function*(pod: Pod) {
    let application = { cpu: 0n, memory: 0n };
    for (const container of pod.containers) {
      application = add(application, {
        cpu: yield* quantity(
          `pods.${pod.namespace}.${pod.name}.containers.${container.name}.cpu`,
          container.requests.cpu,
        ),
        memory: yield* quantity(
          `pods.${pod.namespace}.${pod.name}.containers.${container.name}.memory`,
          container.requests.memory,
        ),
      });
    }

    let initialization = { cpu: 0n, memory: 0n };
    for (const container of pod.initContainers) {
      initialization = max(initialization, {
        cpu: yield* quantity(
          `pods.${pod.namespace}.${pod.name}.initContainers.${container.name}.cpu`,
          container.requests.cpu,
        ),
        memory: yield* quantity(
          `pods.${pod.namespace}.${pod.name}.initContainers.${container.name}.memory`,
          container.requests.memory,
        ),
      });
    }

    return add(max(application, initialization), {
      cpu: yield* quantity(
        `pods.${pod.namespace}.${pod.name}.overhead.cpu`,
        pod.overhead.cpu,
      ),
      memory: yield* quantity(
        `pods.${pod.namespace}.${pod.name}.overhead.memory`,
        pod.overhead.memory,
      ),
    });
  },
);

function tolerates(taint: Taint, toleration: Toleration): boolean {
  if (toleration.effect !== null && toleration.effect !== taint.effect) {
    return false;
  }
  if (toleration.operator === "Exists") {
    return toleration.key === "" || toleration.key === taint.key;
  }
  return (
    toleration.key === taint.key &&
    toleration.value !== null &&
    toleration.value === (taint.value ?? "")
  );
}

function matchesRequirement(
  labels: Readonly<Record<string, string>>,
  requirement: Requirement,
): boolean {
  const value = labels[requirement.key];
  switch (requirement.operator) {
    case "In":
      return value !== undefined && requirement.values.includes(value);
    case "NotIn":
      return value !== undefined && !requirement.values.includes(value);
    case "Exists":
      return value !== undefined;
    case "DoesNotExist":
      return value === undefined;
    case "Gt":
    case "Lt": {
      if (value === undefined || requirement.values.length !== 1) return false;
      const expected = Number(requirement.values[0]);
      const observed = Number(value);
      if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(observed)) {
        return false;
      }
      return requirement.operator === "Gt"
        ? observed > expected
        : observed < expected;
    }
  }
}

function matchesTerms(
  node: Node,
  terms: ReadonlyArray<ReadonlyArray<Requirement>>,
): boolean {
  if (terms.length === 0) return true;
  return terms.some((term) =>
    term.every((requirement) =>
      matchesRequirement(node.labels, requirement),
    ),
  );
}

function matchesDesiredNode(node: Node, snapshot: CapacityPreflightSnapshot) {
  if (node.unschedulable) return false;
  for (const [key, value] of Object.entries(snapshot.desired.nodeSelector)) {
    if (node.labels[key] !== value) return false;
  }
  return node.taints
    .filter(({ effect }) => effect === "NoSchedule" || effect === "NoExecute")
    .every((taint) =>
      snapshot.desired.tolerations.some((toleration) =>
        tolerates(taint, toleration),
      ),
    );
}

function isActivePod(pod: Pod): boolean {
  return pod.phase !== "Failed" && pod.phase !== "Succeeded";
}

function resolveStorageClass(snapshot: CapacityPreflightSnapshot) {
  if (snapshot.desired.storageClassName !== null) {
    return snapshot.observations.storageClasses.find(
      ({ name }) => name === snapshot.desired.storageClassName,
    );
  }
  const defaults = snapshot.observations.storageClasses.filter(
    ({ isDefault }) => isDefault,
  );
  return defaults.length === 1 ? defaults[0] : undefined;
}

const evaluate = Effect.fn("agentos.capacityPreflight.evaluate")(function*(
  snapshot: CapacityPreflightSnapshot,
) {
  const blockers: CapacityReason[] = [];
  const uncertainties: CapacityReason[] = [];
  const desired = {
    cpu: yield* quantity("desired.cpu", snapshot.desired.cpu),
    memory: yield* quantity("desired.memory", snapshot.desired.memory),
    storage: yield* quantity("desired.storage", snapshot.desired.storage),
  };

  const incomplete = [
    ["nodes", snapshot.observations.nodesComplete],
    ["persistentVolumeClaims", snapshot.observations.persistentVolumeClaimsComplete],
    ["persistentVolumes", snapshot.observations.persistentVolumesComplete],
    ["pods", snapshot.observations.podsComplete],
    ["resourceQuotas", snapshot.observations.resourceQuotasComplete],
    ["storageClasses", snapshot.observations.storageClassesComplete],
  ].filter(([, complete]) => complete === false);
  if (incomplete.length > 0) {
    uncertainties.push(
      reason(
        "incomplete_observation",
        "One or more native Kubernetes observations are incomplete.",
        { components: incomplete.map(([name]) => name).join(",") },
      ),
    );
  }
  if (snapshot.desired.unsupportedSchedulingConstraints) {
    uncertainties.push(
      reason(
        "unsupported_scheduling_constraints",
        "The desired Pod contains scheduler constraints outside this classifier contract.",
      ),
    );
  }

  if (snapshot.observations.resourceQuotas.length === 0) {
    uncertainties.push(
      reason(
        "quota_observation_missing",
        "No domain ResourceQuota observation was supplied.",
      ),
    );
  }
  const quotaRequirements: ReadonlyArray<
    readonly [string, bigint, string]
  > = [
    ["count/pods", 1_000_000_000n, "one Pod"],
    [
      "count/persistentvolumeclaims",
      snapshot.desired.retainedPvcName === null ? 1_000_000_000n : 0n,
      "one new PVC",
    ],
    ["requests.cpu", desired.cpu, snapshot.desired.cpu],
    ["requests.memory", desired.memory, snapshot.desired.memory],
    [
      "requests.storage",
      snapshot.desired.retainedPvcName === null ? desired.storage : 0n,
      snapshot.desired.storage,
    ],
  ];
  for (const quota of snapshot.observations.resourceQuotas) {
    for (const [resource, requested, requestedLabel] of quotaRequirements) {
      const hardValue = quota.hard[resource];
      const usedValue = quota.used[resource];
      if (hardValue === undefined || usedValue === undefined) {
        uncertainties.push(
          reason(
            "quota_observation_missing",
            `Quota ${quota.name} does not report ${resource} hard and used values.`,
            { quota: quota.name, resource },
          ),
        );
        continue;
      }
      const hard = yield* quantity(`quotas.${quota.name}.hard.${resource}`, hardValue);
      const used = yield* quantity(`quotas.${quota.name}.used.${resource}`, usedValue);
      if (used + requested > hard) {
        blockers.push(
          reason(
            "quota_exhausted",
            `Quota ${quota.name} has insufficient ${resource} headroom.`,
            {
              hard: hardValue,
              quota: quota.name,
              requested: requestedLabel,
              resource,
              used: usedValue,
            },
          ),
        );
      }
    }
  }

  const nodeUsage = new Map<string, { cpu: bigint; memory: bigint }>();
  for (const node of snapshot.observations.nodes) {
    nodeUsage.set(node.name, { cpu: 0n, memory: 0n });
  }
  for (const pod of snapshot.observations.pods.filter(isActivePod)) {
    if (pod.nodeName === null) {
      uncertainties.push(
        reason(
          "pending_pod_capacity_race",
          `Active Pod ${pod.namespace}/${pod.name} is not assigned to a node yet.`,
          { namespace: pod.namespace, pod: pod.name },
        ),
      );
      continue;
    }
    const current = nodeUsage.get(pod.nodeName);
    if (current === undefined) {
      uncertainties.push(
        reason(
          "incomplete_observation",
          `Pod ${pod.namespace}/${pod.name} references an unobserved node.`,
          { node: pod.nodeName, pod: `${pod.namespace}/${pod.name}` },
        ),
      );
      continue;
    }
    nodeUsage.set(pod.nodeName, add(current, yield* podRequest(pod)));
  }

  let candidates = snapshot.observations.nodes.filter((node) =>
    matchesDesiredNode(node, snapshot),
  );
  if (candidates.length === 0 && snapshot.observations.nodesComplete) {
    blockers.push(
      reason(
        "no_schedulable_node",
        "No observed schedulable node satisfies the desired selectors and taints.",
      ),
    );
  }

  const capacityCandidates: Node[] = [];
  for (const node of candidates) {
    const allocatable = {
      cpu: yield* quantity(`nodes.${node.name}.allocatable.cpu`, node.allocatable.cpu),
      memory: yield* quantity(
        `nodes.${node.name}.allocatable.memory`,
        node.allocatable.memory,
      ),
    };
    const used = nodeUsage.get(node.name) ?? { cpu: 0n, memory: 0n };
    if (
      used.cpu + desired.cpu <= allocatable.cpu &&
      used.memory + desired.memory <= allocatable.memory
    ) {
      capacityCandidates.push(node);
    }
  }
  if (
    candidates.length > 0 &&
    capacityCandidates.length === 0 &&
    snapshot.observations.nodesComplete &&
    snapshot.observations.podsComplete
  ) {
    blockers.push(
      reason(
        "node_capacity_exhausted",
        "No eligible node has enough unrequested CPU and memory for the desired Pod.",
      ),
    );
  }
  candidates = capacityCandidates;

  const storageClass = resolveStorageClass(snapshot);
  if (storageClass === undefined) {
    if (snapshot.observations.storageClassesComplete) {
      blockers.push(
        reason(
          "storage_class_missing",
          "The desired or unique default StorageClass is not present.",
          { storageClass: snapshot.desired.storageClassName ?? "<default>" },
        ),
      );
    }
  } else {
    if (storageClass.storageMode !== snapshot.desired.storageMode) {
      uncertainties.push(
        reason(
          "storage_mode_mismatch",
          "The declared portable/node-local behavior disagrees with the observed StorageClass contract.",
          {
            declared: snapshot.desired.storageMode,
            observed: storageClass.storageMode,
            storageClass: storageClass.name,
          },
        ),
      );
    }
    if (storageClass.volumeBindingMode === null) {
      uncertainties.push(
        reason(
          "invalid_storage_binding_mode",
          "The StorageClass does not report a supported volume binding mode.",
          { storageClass: storageClass.name },
        ),
      );
    }
    if (storageClass.allowedTopologies.length > 0) {
      const topologyCandidates = candidates.filter((node) =>
        matchesTerms(node, storageClass.allowedTopologies),
      );
      if (
        candidates.length > 0 &&
        topologyCandidates.length === 0 &&
        snapshot.observations.nodesComplete
      ) {
        blockers.push(
          reason(
            "storage_topology_conflict",
            "No compute-eligible node satisfies the StorageClass topology.",
            { storageClass: storageClass.name },
          ),
        );
      }
      candidates = topologyCandidates;
    }
  }

  if (snapshot.desired.retainedPvcName === null) {
    if (snapshot.desired.storageMode === "node_local") {
      uncertainties.push(
        reason(
          "node_local_volume_unbound",
          "A new node-local claim has no retained bound PV whose node can be proven before scheduling.",
          { storageClass: snapshot.desired.storageClassName ?? "<default>" },
        ),
      );
    }
  } else {
    const retainedName = snapshot.desired.retainedPvcName;
    const claim = snapshot.observations.persistentVolumeClaims.find(
      ({ name, namespace }) =>
        name === retainedName && namespace === snapshot.desired.namespace,
    );
    if (claim === undefined) {
      if (snapshot.observations.persistentVolumeClaimsComplete) {
        blockers.push(
          reason(
            "retained_pvc_missing",
            "The requested retained PVC does not exist in the domain namespace.",
            { namespace: snapshot.desired.namespace, pvc: retainedName },
          ),
        );
      }
    } else if (claim.phase === "Lost") {
      blockers.push(
        reason(
          "retained_pvc_lost",
          "The retained PVC is Lost.",
          { pvc: retainedName },
        ),
      );
    } else if (claim.phase === "Pending" || claim.volumeName === null) {
      uncertainties.push(
        reason(
          "retained_pvc_pending",
          "The retained PVC is not bound to a PV yet.",
          { pvc: retainedName },
        ),
      );
    } else {
      const expectedStorageClassName =
        storageClass?.name ?? snapshot.desired.storageClassName;
      if (claim.storageClassName !== expectedStorageClassName) {
        blockers.push(
          reason(
            "storage_class_missing",
            "The retained PVC StorageClass differs from the desired workload contract.",
            {
              desired: expectedStorageClassName ?? "<default>",
              observed: claim.storageClassName ?? "<default>",
              pvc: retainedName,
            },
          ),
        );
      }
      const oneWriter = claim.accessModes.some(
        (mode) => mode === "ReadWriteOnce" || mode === "ReadWriteOncePod",
      );
      if (
        oneWriter &&
        snapshot.observations.pods.some(
          (pod) =>
            isActivePod(pod) &&
            pod.name !== snapshot.desired.podName &&
            pod.namespace === snapshot.desired.namespace &&
            pod.persistentVolumeClaimNames.includes(retainedName),
        )
      ) {
        blockers.push(
          reason(
            "retained_pvc_in_use",
            "Another active Pod uses the retained one-writer PVC.",
            { pvc: retainedName },
          ),
        );
      }

      const volume = snapshot.observations.persistentVolumes.find(
        ({ name }) => name === claim.volumeName,
      );
      if (volume === undefined) {
        if (snapshot.observations.persistentVolumesComplete) {
          blockers.push(
            reason(
              "retained_pv_missing",
              "The retained PVC references a PV that was not observed.",
              { pvc: retainedName, pv: claim.volumeName },
            ),
          );
        }
      } else {
        const pvCandidates = candidates.filter((node) =>
          matchesTerms(node, volume.nodeAffinityTerms),
        );
        if (
          candidates.length > 0 &&
          pvCandidates.length === 0 &&
          snapshot.observations.nodesComplete
        ) {
          blockers.push(
            reason(
              "retained_pv_node_conflict",
              "The retained PV node affinity conflicts with every compute-eligible node.",
              { pv: volume.name, pvc: retainedName },
            ),
          );
        }
        if (
          snapshot.desired.storageMode === "node_local" &&
          volume.nodeAffinityTerms.length === 0
        ) {
          uncertainties.push(
            reason(
              "storage_mode_mismatch",
              "The retained node-local PV has no explicit node affinity.",
              { pv: volume.name },
            ),
          );
        }
        candidates = pvCandidates;
      }
    }
  }

  const status: CapacityPreflightResult["status"] =
    blockers.length > 0
      ? "provably_blocked"
      : uncertainties.length > 0
        ? "inconclusive"
        : "fits";
  return {
    eligibleNodeNames: candidates.map(({ name }) => name).sort(),
    reasons: status === "provably_blocked" ? [...blockers, ...uncertainties] : uncertainties,
    reservation: false,
    status,
  } satisfies CapacityPreflightResult;
});

export const classifyCrewmateCapacity = Effect.fn(
  "agentos.capacityPreflight.classify",
)(function*(input: unknown) {
  const snapshot = yield* Schema.decodeUnknownEffect(CapacityPreflightSnapshot)(
    input,
  ).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        inputError(
          "snapshot",
          "Capacity preflight snapshot does not match contract version 1",
        ),
      ),
    ),
  );
  return yield* evaluate(snapshot);
});
