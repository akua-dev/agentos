import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  CapacityPreflightInputError,
  CapacityPreflightSnapshot,
  classifyCrewmateCapacity,
  type CapacityPreflightSnapshot as CapacityPreflightSnapshotType,
} from "../capacity-preflight";

class CapacityFixtureError extends Schema.TaggedErrorClass<CapacityFixtureError>()(
  "CapacityFixtureError",
  { message: Schema.String },
) {}

const quotaHard = {
  "count/persistentvolumeclaims": "16",
  "count/pods": "16",
  "requests.cpu": "16",
  "requests.memory": "32Gi",
  "requests.storage": "320Gi",
};

function snapshot(): CapacityPreflightSnapshotType {
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

const runProgram = Effect.fn("test.capacityPreflight.runProgram")(
  function*(input: string) {
    const paths = yield* Path.Path;
    const entrypoint = yield* paths.fromFileUrl(
      new URL("../capacity-preflight-main.ts", import.meta.url),
    );
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make("bun", [entrypoint], {
        stdin: Stream.make(new TextEncoder().encode(input)),
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      ], { concurrency: "unbounded" });
      return { exitCode, stderr, stdout };
    }));
  },
);

function reasonCodes(
  result: Effect.Success<ReturnType<typeof classifyCrewmateCapacity>>,
) {
  return result.reasons.map(({ code }) => code);
}

function first<Item>(items: ReadonlyArray<Item>, label: string) {
  const item = items[0];
  return item === undefined
    ? Effect.fail(CapacityFixtureError.make({ message: `${label} is empty` }))
    : Effect.succeed(item);
}

function withDesired(
  input: CapacityPreflightSnapshotType,
  desired: Partial<CapacityPreflightSnapshotType["desired"]>,
): CapacityPreflightSnapshotType {
  return { ...input, desired: { ...input.desired, ...desired } };
}

function withObservations(
  input: CapacityPreflightSnapshotType,
  observations: Partial<CapacityPreflightSnapshotType["observations"]>,
): CapacityPreflightSnapshotType {
  return {
    ...input,
    observations: { ...input.observations, ...observations },
  };
}

type StorageClass =
  CapacityPreflightSnapshotType["observations"]["storageClasses"][number];
type PersistentVolumeClaim =
  CapacityPreflightSnapshotType["observations"]["persistentVolumeClaims"][number];
type PersistentVolume =
  CapacityPreflightSnapshotType["observations"]["persistentVolumes"][number];

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

describe("Effect Crewmate capacity preflight", () => {
  layer(BunServices.layer)((it) => {
    it.effect(
      "reports fits only when quota, compute, and portable storage observations agree",
      () => Effect.gen(function*() {
        const result = yield* classifyCrewmateCapacity(snapshot());
        assert.deepInclude(result, {
          status: "fits",
          reservation: false,
          eligibleNodeNames: ["worker-a"],
        });
        assert.deepStrictEqual(result.reasons, []);
      }),
    );

    it.effect("reports quota exhaustion as provably blocked", () =>
      Effect.gen(function*() {
        const base = snapshot();
        const quota = yield* first(
          base.observations.resourceQuotas,
          "resource quotas",
        );
        const input = withObservations(base, {
          resourceQuotas: [
            { ...quota, used: { ...quota.used, "requests.cpu": "16" } },
          ],
        });
        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "provably_blocked");
        assert.include(reasonCodes(result), "quota_exhausted");
      }));

    it.effect("reports cluster request exhaustion as provably blocked", () =>
      Effect.gen(function*() {
        const base = snapshot();
        const pod = yield* first(base.observations.pods, "pods");
        const container = yield* first(pod.containers, "Pod containers");
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
        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "provably_blocked");
        assert.include(reasonCodes(result), "node_capacity_exhausted");
      }));

    it.effect("never turns incomplete node or pod observations into a fit", () =>
      Effect.gen(function*() {
        const input = withObservations(snapshot(), { podsComplete: false });
        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "inconclusive");
        assert.include(reasonCodes(result), "incomplete_observation");
      }));

    it.effect("detects a retained bound-PV node-affinity conflict", () =>
      Effect.gen(function*() {
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

        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "provably_blocked");
        assert.include(reasonCodes(result), "retained_pv_node_conflict");
      }));

    it.effect(
      "detects another active Pod using a retained one-writer claim",
      () => Effect.gen(function*() {
        const base = withDesired(snapshot(), {
          retainedPvcName: "home-agentos-crewmate-0",
        });
        const stalePod: CapacityPreflightSnapshotType["observations"]["pods"][number] = {
          namespace: "agentos-domain-alpha",
          name: "stale-crewmate-0",
          phase: "Running",
          nodeName: "worker-a",
          containers: [
            {
              name: "crewmate",
              requests: { cpu: "100m", memory: "128Mi" },
            },
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

        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "provably_blocked");
        assert.include(reasonCodes(result), "retained_pvc_in_use");
      }),
    );

    it.effect("treats an unbound node-local volume as inconclusive", () =>
      Effect.gen(function*() {
        const desired = withDesired(snapshot(), {
          storageClassName: "local-static",
          storageMode: "node_local",
        });
        const input = withObservations(desired, {
          storageClasses: [localStorageClass()],
        });

        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "inconclusive");
        assert.include(reasonCodes(result), "node_local_volume_unbound");
      }));

    it.effect("accepts a retained node-local claim when its PV and node agree", () =>
      Effect.gen(function*() {
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

        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "fits");
        assert.deepStrictEqual(result.eligibleNodeNames, ["worker-a"]);
      }));

    it.effect("accepts a retained claim using the resolved default StorageClass", () =>
      Effect.gen(function*() {
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

        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "fits");
        assert.deepStrictEqual(result.reasons, []);
      }));

    it.effect("returns inconclusive for unsupported scheduling constraints", () =>
      Effect.gen(function*() {
        const input = withDesired(snapshot(), {
          unsupportedSchedulingConstraints: true,
        });
        const result = yield* classifyCrewmateCapacity(input);
        assert.strictEqual(result.status, "inconclusive");
        assert.include(
          reasonCodes(result),
          "unsupported_scheduling_constraints",
        );
      }));

    it.effect("fails with a typed input error for invalid Kubernetes quantities", () =>
      Effect.gen(function*() {
        const input = withDesired(snapshot(), { cpu: "lots" });
        const failure = yield* classifyCrewmateCapacity(input).pipe(
          Effect.flip,
        );
        assert.instanceOf(failure, CapacityPreflightInputError);
      }));

    it.effect("exposes the classifier as a JSON stdin program boundary", () =>
      Effect.gen(function*() {
        const input = yield* Schema.encodeEffect(
          Schema.fromJsonString(CapacityPreflightSnapshot),
        )(snapshot());
        assert.deepStrictEqual(yield* runProgram(input), {
          exitCode: 0,
          stderr: "",
          stdout:
            '{"eligibleNodeNames":["worker-a"],"reasons":[],"reservation":false,"status":"fits"}\n',
        });
      }));

    it.effect("fails the JSON stdin boundary without a stack or partial result", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* runProgram("not-json"), {
          exitCode: 1,
          stderr: "Capacity preflight stdin must be valid JSON\n",
          stdout: "",
        });
      }));
  });
});
