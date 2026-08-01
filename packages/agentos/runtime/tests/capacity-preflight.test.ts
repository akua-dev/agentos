import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CapacityPreflightInputError,
  classifyCrewmateCapacity,
  type CapacityPreflightSnapshot,
} from "../capacity-preflight";

const quotaHard = {
  "count/persistentvolumeclaims": "16",
  "count/pods": "16",
  "requests.cpu": "16",
  "requests.memory": "32Gi",
  "requests.storage": "320Gi",
};

function snapshot(): CapacityPreflightSnapshot {
  return {
    version: 1,
    desired: {
      namespace: "agentos-domain-alpha",
      podName: "agentos-crewmate-0",
      cpu: "500m",
      memory: "1Gi",
      storage: "20Gi",
      storageClassName: "portable-csi",
      storageMode: "portable",
      retainedPvcName: null,
      nodeSelector: {},
      tolerations: [],
      unsupportedSchedulingConstraints: false,
    },
    observations: {
      resourceQuotasComplete: true,
      nodesComplete: true,
      podsComplete: true,
      storageClassesComplete: true,
      persistentVolumeClaimsComplete: true,
      persistentVolumesComplete: true,
      resourceQuotas: [
        {
          name: "agentos-domain-capacity",
          hard: quotaHard,
          used: {
            "count/persistentvolumeclaims": "1",
            "count/pods": "1",
            "requests.cpu": "250m",
            "requests.memory": "512Mi",
            "requests.storage": "20Gi",
          },
        },
      ],
      nodes: [
        {
          name: "worker-a",
          labels: {
            "kubernetes.io/hostname": "worker-a",
            "topology.kubernetes.io/zone": "zone-a",
          },
          unschedulable: false,
          taints: [],
          allocatable: { cpu: "4", memory: "8Gi" },
        },
      ],
      pods: [
        {
          namespace: "agentos-domain-alpha",
          name: "agentos-secondmate-0",
          phase: "Running",
          nodeName: "worker-a",
          containers: [
            {
              name: "agentos",
              requests: { cpu: "250m", memory: "512Mi" },
            },
          ],
          initContainers: [],
          overhead: { cpu: "0", memory: "0" },
          persistentVolumeClaimNames: ["home-agentos-secondmate-0"],
        },
      ],
      storageClasses: [
        {
          name: "portable-csi",
          provisioner: "csi.example.test",
          volumeBindingMode: "WaitForFirstConsumer",
          storageMode: "portable",
          isDefault: true,
          allowedTopologies: [],
        },
      ],
      persistentVolumeClaims: [],
      persistentVolumes: [],
    },
  };
}

async function classify(input: unknown) {
  return Effect.runPromise(classifyCrewmateCapacity(input));
}

async function runProgram(input: string) {
  const child = Bun.spawn(
    [
      "bun",
      new URL("../capacity-preflight-main.ts", import.meta.url).pathname,
    ],
    { stdin: "pipe", stderr: "pipe", stdout: "pipe" },
  );
  const standardInput = child.stdin;
  if (standardInput === undefined) throw new Error("Program stdin was not opened");
  standardInput.write(input);
  standardInput.end();
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function reasonCodes(result: Awaited<ReturnType<typeof classify>>) {
  return result.reasons.map(({ code }) => code);
}

function first<Item>(items: ReadonlyArray<Item>, label: string): Item {
  const item = items[0];
  if (item === undefined) throw new Error(`${label} is empty`);
  return item;
}

function withDesired(
  input: CapacityPreflightSnapshot,
  desired: Partial<CapacityPreflightSnapshot["desired"]>,
): CapacityPreflightSnapshot {
  return { ...input, desired: { ...input.desired, ...desired } };
}

function withObservations(
  input: CapacityPreflightSnapshot,
  observations: Partial<CapacityPreflightSnapshot["observations"]>,
): CapacityPreflightSnapshot {
  return {
    ...input,
    observations: { ...input.observations, ...observations },
  };
}

type StorageClass = CapacityPreflightSnapshot["observations"]["storageClasses"][number];
type PersistentVolumeClaim = CapacityPreflightSnapshot["observations"]["persistentVolumeClaims"][number];
type PersistentVolume = CapacityPreflightSnapshot["observations"]["persistentVolumes"][number];

function localStorageClass(): StorageClass {
  return {
    name: "local-static",
    provisioner: "kubernetes.io/no-provisioner",
    volumeBindingMode: "WaitForFirstConsumer",
    storageMode: "node_local",
    isDefault: false,
    allowedTopologies: [],
  };
}

function retainedClaim(
  volumeName: string,
  storageClassName = "local-static",
): PersistentVolumeClaim {
  return {
    namespace: "agentos-domain-alpha",
    name: "home-agentos-crewmate-0",
    phase: "Bound",
    volumeName,
    storageClassName,
    accessModes: ["ReadWriteOnce"],
  };
}

function retainedVolume(
  name: string,
  storageClassName: string,
  nodeAffinityTerms: PersistentVolume["nodeAffinityTerms"],
): PersistentVolume {
  return { name, nodeAffinityTerms, storageClassName };
}

describe("Crewmate capacity preflight", () => {
  test("reports fits only when quota, compute, and portable storage observations agree", async () => {
    const result = await classify(snapshot());
    expect(result).toMatchObject({
      status: "fits",
      reservation: false,
      eligibleNodeNames: ["worker-a"],
    });
    expect(result.reasons).toEqual([]);
  });

  test("reports quota exhaustion as provably blocked", async () => {
    const base = snapshot();
    const quota = first(
      base.observations.resourceQuotas,
      "resource quotas",
    );
    const input = withObservations(base, {
      resourceQuotas: [
        { ...quota, used: { ...quota.used, "requests.cpu": "16" } },
      ],
    });
    const result = await classify(input);
    expect(result.status).toBe("provably_blocked");
    expect(reasonCodes(result)).toContain("quota_exhausted");
  });

  test("reports cluster request exhaustion as provably blocked", async () => {
    const base = snapshot();
    const pod = first(base.observations.pods, "pods");
    const container = first(pod.containers, "Pod containers");
    const input = withObservations(base, {
      pods: [
        {
          ...pod,
          containers: [
            {
              ...container,
              requests: { cpu: "3900m", memory: "7800Mi" },
            },
            ...pod.containers.slice(1),
          ],
        },
      ],
    });
    const result = await classify(input);
    expect(result.status).toBe("provably_blocked");
    expect(reasonCodes(result)).toContain("node_capacity_exhausted");
  });

  test("never turns incomplete node or pod observations into a fit", async () => {
    const input = withObservations(snapshot(), { podsComplete: false });
    const result = await classify(input);
    expect(result.status).toBe("inconclusive");
    expect(reasonCodes(result)).toContain("incomplete_observation");
  });

  test("detects a retained bound-PV node-affinity conflict", async () => {
    const desired = withDesired(snapshot(), {
      retainedPvcName: "home-agentos-crewmate-0",
      storageClassName: "local-static",
      storageMode: "node_local",
    });
    const input = withObservations(desired, {
      persistentVolumeClaims: [retainedClaim("local-pv-b")],
      persistentVolumes: [
        retainedVolume("local-pv-b", "local-static", [
          [
            {
              key: "topology.kubernetes.io/zone",
              operator: "In",
              values: ["zone-b"],
            },
          ],
        ]),
      ],
      storageClasses: [localStorageClass()],
    });

    const result = await classify(input);
    expect(result.status).toBe("provably_blocked");
    expect(reasonCodes(result)).toContain("retained_pv_node_conflict");
  });

  test("detects another active Pod using a retained one-writer claim", async () => {
    const base = withDesired(snapshot(), {
      retainedPvcName: "home-agentos-crewmate-0",
    });
    const stalePod: CapacityPreflightSnapshot["observations"]["pods"][number] = {
      namespace: "agentos-domain-alpha",
      name: "stale-crewmate-0",
      phase: "Running",
      nodeName: "worker-a",
      containers: [
        { name: "crewmate", requests: { cpu: "100m", memory: "128Mi" } },
      ],
      initContainers: [],
      overhead: { cpu: "0", memory: "0" },
      persistentVolumeClaimNames: ["home-agentos-crewmate-0"],
    };
    const input = withObservations(base, {
      persistentVolumeClaims: [
        retainedClaim("portable-pv", "portable-csi"),
      ],
      persistentVolumes: [
        retainedVolume("portable-pv", "portable-csi", []),
      ],
      pods: [...base.observations.pods, stalePod],
    });

    const result = await classify(input);
    expect(result.status).toBe("provably_blocked");
    expect(reasonCodes(result)).toContain("retained_pvc_in_use");
  });

  test("treats an unbound node-local volume as inconclusive", async () => {
    const desired = withDesired(snapshot(), {
      storageClassName: "local-static",
      storageMode: "node_local",
    });
    const input = withObservations(desired, {
      storageClasses: [localStorageClass()],
    });

    const result = await classify(input);
    expect(result.status).toBe("inconclusive");
    expect(reasonCodes(result)).toContain("node_local_volume_unbound");
  });

  test("accepts a retained node-local claim when its PV and node agree", async () => {
    const desired = withDesired(snapshot(), {
      retainedPvcName: "home-agentos-crewmate-0",
      storageClassName: "local-static",
      storageMode: "node_local",
    });
    const input = withObservations(desired, {
      persistentVolumeClaims: [retainedClaim("local-pv-a")],
      persistentVolumes: [
        retainedVolume("local-pv-a", "local-static", [
          [
            {
              key: "kubernetes.io/hostname",
              operator: "In",
              values: ["worker-a"],
            },
          ],
        ]),
      ],
      storageClasses: [localStorageClass()],
    });

    const result = await classify(input);
    expect(result.status).toBe("fits");
    expect(result.eligibleNodeNames).toEqual(["worker-a"]);
  });

  test("accepts a retained claim using the resolved default StorageClass", async () => {
    const desired = withDesired(snapshot(), {
      retainedPvcName: "home-agentos-crewmate-0",
      storageClassName: null,
    });
    const input = withObservations(desired, {
      persistentVolumeClaims: [
        retainedClaim("portable-pv", "portable-csi"),
      ],
      persistentVolumes: [
        retainedVolume("portable-pv", "portable-csi", []),
      ],
    });

    const result = await classify(input);
    expect(result.status).toBe("fits");
    expect(result.reasons).toEqual([]);
  });

  test("returns inconclusive for unsupported scheduling constraints", async () => {
    const input = withDesired(snapshot(), {
      unsupportedSchedulingConstraints: true,
    });
    const result = await classify(input);
    expect(result.status).toBe("inconclusive");
    expect(reasonCodes(result)).toContain(
      "unsupported_scheduling_constraints",
    );
  });

  test("fails with a typed input error for invalid Kubernetes quantities", async () => {
    const input = withDesired(snapshot(), { cpu: "lots" });
    await expect(classify(input)).rejects.toBeInstanceOf(
      CapacityPreflightInputError,
    );
  });

  test("exposes the classifier as a JSON stdin program boundary", async () => {
    const result = await runProgram(JSON.stringify(snapshot()));
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        '{"eligibleNodeNames":["worker-a"],"reasons":[],"reservation":false,"status":"fits"}\n',
    });
  });

  test("fails the JSON stdin boundary without a stack or partial result", async () => {
    const result = await runProgram("not-json");
    expect(result).toEqual({
      exitCode: 1,
      stderr: "Capacity preflight stdin must be valid JSON\n",
      stdout: "",
    });
  });
});
