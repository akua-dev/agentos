import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { renderKustomize } from "../../../../../tooling/testing/kubernetes.ts";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../access/identity.ts";
import { compileAgentWorkloadSpec } from "../compiler.ts";

const packageRootUrl = new URL("../../../", import.meta.url);
const workloadImage =
  `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;
const ResourceEnvelope = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
});
const VolumeMount = Schema.Struct({
  mountPath: Schema.String,
  name: Schema.String,
  readOnly: Schema.optional(Schema.Boolean),
});
const Container = Schema.Struct({
  args: Schema.optional(Schema.Array(Schema.String)),
  image: Schema.String,
  name: Schema.String,
  volumeMounts: Schema.optional(Schema.Array(VolumeMount)),
});
const ProjectedVolume = Schema.Struct({
  defaultMode: Schema.Number,
  sources: Schema.Array(Schema.Struct({
    serviceAccountToken: Schema.Struct({
      audience: Schema.String,
      expirationSeconds: Schema.Number,
      path: Schema.String,
    }),
  })),
});
const Volume = Schema.Struct({
  name: Schema.String,
  projected: Schema.optional(ProjectedVolume),
  secret: Schema.optional(Schema.Struct({
    secretName: Schema.String,
  })),
});
const PodSpec = Schema.Struct({
  automountServiceAccountToken: Schema.Boolean,
  containers: Schema.Array(Container),
  initContainers: Schema.Array(Container),
  serviceAccountName: Schema.String,
  volumes: Schema.Array(Volume),
});
const StatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.Struct({
    replicas: Schema.Number,
    template: Schema.Struct({
      metadata: Schema.Struct({
        annotations: Schema.Record(Schema.String, Schema.String),
      }),
      spec: PodSpec,
    }),
  }),
});

type Profile = "persistent-mate" | "interactive-crewmate";
type RenderedResource = {
  readonly envelope: typeof ResourceEnvelope.Type;
  readonly source: unknown;
};
type PodSpec = typeof PodSpec.Type;

export class KustomizeConformanceError extends Schema.TaggedErrorClass<KustomizeConformanceError>()(
  "KustomizeConformanceError",
  { resource: Schema.String },
) {}

function workloadSpec(
  profile: Profile,
  distributionRoot: string,
  overlayRoot: string,
) {
  const persistent = profile === "persistent-mate";
  const namespace = persistent
    ? "agentos-domain-platform"
    : "agentos-domain-alpha";
  const workload = persistent
    ? "agentos-platform-mate"
    : "agentos-crewmate-api";
  const databaseIdentity = persistent
    ? "runtime_platform_mate"
    : "runtime_crewmate_api";
  return {
    version: 1,
    distributionRoot,
    overlayRoot,
    profile: { name: profile, version: 1 },
    fleet: "default",
    namespace,
    identity: {
      agentId: persistent
        ? "00000000-0000-4000-8000-000000000002"
        : "00000000-0000-4000-8000-000000000003",
      ownerAgentId: persistent
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
      taskId: persistent
        ? null
        : "00000000-0000-4000-8000-000000000004",
      assignmentId: persistent
        ? null
        : "00000000-0000-4000-8000-000000000005",
      role: persistent ? "second_mate" : "crewmate",
      agentName: persistent ? "platform-mate" : "crewmate-api",
    },
    names: {
      workload,
      service: workload,
      serviceAccount: workload,
      herdrSession: workload,
    },
    ownerServiceAccount: {
      name: persistent ? "agentos-firstmate" : "agentos-secondmate",
      namespace: persistent ? "agentos" : namespace,
    },
    image: {
      reference: workloadImage,
      pullPolicy: "IfNotPresent",
    },
    harness: persistent ? "pi" : "codex",
    home: {
      accessMode: "ReadWriteOnce",
      retention: "Retain",
      size: "20Gi",
      storageClassName: "portable-csi",
    },
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
    scheduling: { nodeSelector: {}, tolerations: [] },
    database: {
      identity: databaseIdentity,
      url:
        `postgresql://${databaseIdentity}@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require`,
      secret: { key: "pgpass", name: `${workload}-postgres` },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: persistent
      ? null
      : {
          path: "/home/agent/brief.md",
          sha256: "b".repeat(64),
        },
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: persistent ? "v1" : null, acp: null },
  };
}

const render = Effect.fn("test.workloadCompiler.render")(function*(profile: Profile) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-workload-plan-",
    });
    const canonicalRoot = yield* fileSystem.realPath(root);
    const packageRoot = paths.resolve(yield* paths.fromFileUrl(packageRootUrl));
    const plan = yield* compileAgentWorkloadSpec(
      workloadSpec(profile, packageRoot, canonicalRoot),
    );
    yield* Effect.forEach(
      plan.files,
      ({ path, content }) =>
        fileSystem.writeFileString(paths.join(root, path), content),
      { concurrency: "unbounded" },
    );
    const sources = yield* renderKustomize(canonicalRoot, {
      loadRestrictionsNone: true,
    });
    const resources = yield* Effect.forEach(sources, (source) =>
      Schema.decodeUnknownEffect(ResourceEnvelope)(source).pipe(
        Effect.map((envelope) => ({ envelope, source })),
      ));
    return { plan, resources };
  }));
});

function resourceIdentities(resources: ReadonlyArray<RenderedResource>) {
  return resources.map(({ envelope }) =>
    `${envelope.kind}/${envelope.metadata.name}`
  ).sort();
}

const findStatefulSet = Effect.fn("test.workloadCompiler.findStatefulSet")(
  function*(resources: ReadonlyArray<RenderedResource>, name: string) {
    const resource = resources.find(({ envelope }) =>
      envelope.kind === "StatefulSet" && envelope.metadata.name === name
    );
    if (resource === undefined) {
      return yield* KustomizeConformanceError.make({
        resource: `StatefulSet/${name}`,
      });
    }
    return yield* Schema.decodeUnknownEffect(StatefulSet)(resource.source);
  },
);

function assertEgressIdentityProjection(pod: PodSpec) {
  const identityVolume = pod.volumes.find(
    ({ name }) => name === "agentos-egress-identity",
  );
  assert.deepStrictEqual(identityVolume?.projected, {
    defaultMode: 288,
    sources: [
      {
        serviceAccountToken: {
          audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
          expirationSeconds: AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
          path: "token",
        },
      },
    ],
  });
  for (const container of pod.containers) {
    assert.deepStrictEqual(
      container.volumeMounts?.find(({ name }) =>
        name === "agentos-egress-identity"
      ),
      {
        mountPath: "/var/run/secrets/agentos-egress",
        name: "agentos-egress-identity",
        readOnly: true,
      },
    );
  }
  for (const container of pod.initContainers) {
    assert.isUndefined(
      container.volumeMounts?.find(({ name }) =>
        name === "agentos-egress-identity"
      ),
    );
  }
}

layer(BunServices.layer)("AgentWorkloadSpec native Kustomize output", (it) => {
  it.effect("renders one isolated interactive Crewmate from ordinary native resources", () =>
    Effect.gen(function*() {
      const { plan, resources } = yield* render("interactive-crewmate");
      assert.deepStrictEqual(resourceIdentities(resources), [
        "Service/agentos-crewmate-api",
        "ServiceAccount/agentos-crewmate-api",
        "StatefulSet/agentos-crewmate-api",
      ]);
      const statefulSet = yield* findStatefulSet(
        resources,
        "agentos-crewmate-api",
      );
      const pod = statefulSet.spec.template.spec;
      assert.strictEqual(statefulSet.spec.replicas, 1);
      assert.strictEqual(
        statefulSet.spec.template.metadata.annotations[
          "agentos.akua.dev/workload-profile-definition"
        ],
        plan.summary.profileDefinitionDigest,
      );
      assert.isFalse(pod.automountServiceAccountToken);
      assert.strictEqual(pod.serviceAccountName, "agentos-crewmate-api");
      assert.deepStrictEqual(
        pod.containers.map(({ args, image, name }) => ({ args, image, name })),
        [{
          args: ["server", "--session", "agentos-crewmate-api"],
          name: "crewmate",
          image: workloadImage,
        }],
      );
      assert.deepStrictEqual(
        pod.initContainers.map(({ image, name }) => ({ image, name })),
        ["install-tools", "prepare-home", "prepare-github-provider"].map(
          (name) => ({ name, image: workloadImage }),
        ),
      );
      const databaseVolume = statefulSet.spec.template.spec.volumes.find(
        ({ name }) => name === "database-credentials",
      );
      assert.strictEqual(
        databaseVolume?.secret?.secretName,
        "agentos-crewmate-api-postgres",
      );
      assert.notStrictEqual(
        databaseVolume?.secret?.secretName,
        "agentos-crewmate-postgres",
      );
      assertEgressIdentityProjection(pod);
    }));

  it.effect("renders the persistent Mate and exact released domain controls", () =>
    Effect.gen(function*() {
      const { plan, resources } = yield* render("persistent-mate");
      assert.deepStrictEqual(resourceIdentities(resources), [
        "LimitRange/agentos-domain-workload-limits",
        "Namespace/agentos-domain-platform",
        "NetworkPolicy/agentos-domain-ingress",
        "ResourceQuota/agentos-domain-capacity",
        "Role/agentos-firstmate-domain-supervisor",
        "Role/agentos-secondmate-workload-manager",
        "RoleBinding/agentos-firstmate-domain-supervisor-binding",
        "RoleBinding/agentos-secondmate-workload-manager-binding",
        "Service/agentos-platform-mate",
        "ServiceAccount/agentos-platform-mate",
        "StatefulSet/agentos-platform-mate",
      ]);
      const statefulSet = yield* findStatefulSet(
        resources,
        "agentos-platform-mate",
      );
      const pod = statefulSet.spec.template.spec;
      assert.strictEqual(statefulSet.spec.replicas, 1);
      assert.strictEqual(
        statefulSet.spec.template.metadata.annotations[
          "agentos.akua.dev/workload-profile-definition"
        ],
        plan.summary.profileDefinitionDigest,
      );
      assert.isTrue(pod.automountServiceAccountToken);
      assert.strictEqual(pod.serviceAccountName, "agentos-platform-mate");
      assert.deepStrictEqual(
        pod.containers.map(({ args, image, name }) => ({ args, image, name })),
        [{
          args: ["server", "--session", "agentos-platform-mate"],
          name: "agentos",
          image: workloadImage,
        }],
      );
      assert.deepStrictEqual(
        pod.initContainers.map(({ image, name }) => ({ image, name })),
        ["install-tools", "prepare-home", "prepare-github-provider"].map(
          (name) => ({ name, image: workloadImage }),
        ),
      );
      const databaseVolume = statefulSet.spec.template.spec.volumes.find(
        ({ name }) => name === "database-credentials",
      );
      assert.strictEqual(
        databaseVolume?.secret?.secretName,
        "agentos-platform-mate-postgres",
      );
      assert.notStrictEqual(
        databaseVolume?.secret?.secretName,
        "agentos-secondmate-postgres",
      );
      assertEgressIdentityProjection(pod);
    }));
});
