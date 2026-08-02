import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";

import { renderKustomize } from "../../../tooling/testing/kubernetes.ts";

const Metadata = Schema.Struct({
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Resource = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Metadata,
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);
type Resource = typeof Resource.Type;

const SecretKeySelector = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});
const EnvironmentEntry = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  valueFrom: Schema.optional(Schema.Struct({
    secretKeyRef: Schema.optional(SecretKeySelector),
    fieldRef: Schema.optional(Schema.Unknown),
  })),
});
const VolumeMount = Schema.Struct({
  mountPath: Schema.String,
  name: Schema.String,
  readOnly: Schema.optional(Schema.Boolean),
});
const Container = Schema.Struct({
  name: Schema.String,
  image: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvironmentEntry)),
  readinessProbe: Schema.optional(Schema.Struct({
    httpGet: Schema.Unknown,
  })),
  volumeMounts: Schema.optional(Schema.Array(VolumeMount)),
});
const Volume = Schema.Struct({
  name: Schema.String,
  secret: Schema.optional(Schema.Struct({ defaultMode: Schema.Number })),
  configMap: Schema.optional(Schema.Struct({
    name: Schema.String,
    optional: Schema.optional(Schema.Boolean),
  })),
});
const PodSpec = Schema.Struct({
  automountServiceAccountToken: Schema.optional(Schema.Boolean),
  serviceAccountName: Schema.optional(Schema.String),
  securityContext: Schema.optional(Schema.Unknown),
  containers: Schema.Array(Container),
  volumes: Schema.optional(Schema.Array(Volume)),
});
const Job = Schema.Struct({
  kind: Schema.Literal("Job"),
  metadata: Metadata,
  spec: Schema.Struct({ template: Schema.Struct({ spec: PodSpec }) }),
});
const Deployment = Schema.Struct({
  kind: Schema.Literal("Deployment"),
  metadata: Metadata,
  spec: Schema.Struct({
    replicas: Schema.Number,
    strategy: Schema.Unknown,
    template: Schema.Struct({ spec: PodSpec }),
  }),
});
const DatabaseCluster = Schema.Struct({
  kind: Schema.Literal("Cluster"),
  metadata: Metadata,
  spec: Schema.Struct({
    instances: Schema.Number,
    bootstrap: Schema.Struct({
      initdb: Schema.Struct({
        database: Schema.String,
        owner: Schema.String,
      }),
    }),
    backup: Schema.Unknown,
  }),
});
const DisruptionBudget = Schema.Struct({
  kind: Schema.Literal("PodDisruptionBudget"),
  metadata: Metadata,
  spec: Schema.Struct({ minAvailable: Schema.Number }),
});
const Service = Schema.Struct({
  kind: Schema.Literal("Service"),
  metadata: Metadata,
  spec: Schema.Struct({
    publishNotReadyAddresses: Schema.optional(Schema.Boolean),
  }),
});
const NetworkPolicy = Schema.Struct({
  kind: Schema.Literal("NetworkPolicy"),
  metadata: Metadata,
  spec: Schema.Struct({
    policyTypes: Schema.Array(Schema.String),
    podSelector: Schema.Struct({
      matchLabels: Schema.Record(Schema.String, Schema.String),
    }),
    ingress: Schema.Array(Schema.Struct({
      from: Schema.Array(Schema.Struct({
        namespaceSelector: Schema.Struct({
          matchLabels: Schema.Record(Schema.String, Schema.String),
        }),
        podSelector: Schema.Struct({
          matchLabels: Schema.Record(Schema.String, Schema.String),
        }),
      })),
      ports: Schema.Array(Schema.Struct({
        port: Schema.Number,
        protocol: Schema.String,
      })),
    })),
    egress: Schema.optional(Schema.Unknown),
  }),
});

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.openfgaManifest.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const resource = Effect.fn("test.openfgaManifest.resource")(function*(
  resources: ReadonlyArray<Resource>,
  kind: string,
  name: string,
) {
  return yield* required(
    resources.find((candidate) =>
      candidate.kind === kind && candidate.metadata.name === name
    ),
    `Missing ${kind}/${name}`,
  );
});

function decodeResource<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  kind: string,
  name: string,
) {
  return (resources: ReadonlyArray<Resource>) =>
    resource(resources, kind, name).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    );
}

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) return value.some((item) => containsText(item, text));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsText(item, text));
}

const kubernetesDirectoryUrl = new URL("../kubernetes", import.meta.url);
const render = Effect.fn("test.openfgaManifest.render")(function*() {
  const paths = yield* Path.Path;
  const kubernetesDirectory = yield* paths.fromFileUrl(kubernetesDirectoryUrl);
  const documents = yield* renderKustomize(kubernetesDirectory);
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});
const database = decodeResource(
  DatabaseCluster,
  "Cluster",
  "openfga-postgres",
);
const migration = decodeResource(Job, "Job", "openfga-migrate-v1-18-1");
const deployment = decodeResource(Deployment, "Deployment", "openfga");
const disruption = decodeResource(
  DisruptionBudget,
  "PodDisruptionBudget",
  "openfga",
);
const bootstrapService = decodeResource(Service, "Service", "openfga-bootstrap");
const service = decodeResource(Service, "Service", "openfga");
const bootstrap = decodeResource(
  Job,
  "Job",
  "openfga-bootstrap-agentos-access-v1",
);
const policy = decodeResource(NetworkPolicy, "NetworkPolicy", "openfga");

layer(BunServices.layer)("OpenFGA Kubernetes topology", (it) => {
  it.effect("renders ordered migration, HA runtime, and idempotent bootstrap phases", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
        [
          "Cluster/openfga-postgres",
          "Deployment/openfga",
          "Job/openfga-bootstrap-agentos-access-v1",
          "Job/openfga-migrate-v1-18-1",
          "NetworkPolicy/openfga",
          "PodDisruptionBudget/openfga",
          "Role/openfga-bootstrap",
          "RoleBinding/openfga-bootstrap",
          "Service/openfga",
          "Service/openfga-bootstrap",
          "ServiceAccount/openfga",
          "ServiceAccount/openfga-bootstrap",
        ].sort(),
      );

      const databaseCluster = yield* database(resources);
      assert.strictEqual(databaseCluster.spec.instances, 3);
      assert.deepStrictEqual(databaseCluster.spec.bootstrap.initdb, {
        database: "openfga",
        owner: "openfga",
      });
      assert.deepStrictEqual(databaseCluster.spec.backup, {
        target: "prefer-standby",
        volumeSnapshot: {
          online: true,
          snapshotOwnerReference: "backup",
          onlineConfiguration: {
            immediateCheckpoint: false,
            waitForArchive: false,
          },
        },
      });

      const migrationJob = yield* migration(resources);
      const migrationPod = migrationJob.spec.template.spec;
      assert.isFalse(migrationPod.automountServiceAccountToken);
      const migrationContainer = yield* required(
        migrationPod.containers[0],
        "Missing migration container",
      );
      assert.strictEqual(
        migrationContainer.image,
        "docker.io/openfga/openfga@sha256:efde89d24487da1a8bc37d85b61341f1fb7024943a1ded65f4b7d51a75666688",
      );
      assert.deepStrictEqual(migrationContainer.args, ["migrate"]);

      const runtimeDeployment = yield* deployment(resources);
      assert.strictEqual(runtimeDeployment.spec.replicas, 2);
      assert.deepStrictEqual(runtimeDeployment.spec.strategy, {
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      });
      const pod = runtimeDeployment.spec.template.spec;
      assert.isFalse(pod.automountServiceAccountToken);
      assert.deepInclude(pod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
      });
      assert.lengthOf(pod.containers, 2);
      const runtime = yield* required(
        pod.containers.find(({ name }) => name === "openfga"),
        "Missing OpenFGA runtime container",
      );
      const readiness = yield* required(
        pod.containers.find(({ name }) => name === "semantic-readiness"),
        "Missing semantic readiness container",
      );
      assert.strictEqual(
        runtime.image,
        "docker.io/openfga/openfga@sha256:efde89d24487da1a8bc37d85b61341f1fb7024943a1ded65f4b7d51a75666688",
      );
      assert.deepInclude(
        Object.fromEntries((runtime.env ?? []).map((entry) => [
          entry.name,
          entry.value ?? entry.valueFrom,
        ])),
        {
          OPENFGA_AUTHN_METHOD: "preshared",
          OPENFGA_AUTHN_PRESHARED_KEYS: {
            secretKeyRef: { key: "preshared-key", name: "openfga-admin" },
          },
          OPENFGA_DATASTORE_URI: {
            secretKeyRef: { key: "uri", name: "openfga-postgres-app" },
          },
        },
      );
      assert.deepStrictEqual(runtime.readinessProbe?.httpGet, {
        path: "/readyz",
        port: 8090,
      });
      assert.deepStrictEqual(readiness.command, ["agentos-openfga-readiness"]);
      assert.deepStrictEqual(readiness.volumeMounts, [
        {
          mountPath: "/var/run/secrets/agentos-openfga",
          name: "admin",
          readOnly: true,
        },
        {
          mountPath: "/var/run/agentos/openfga-deployment",
          name: "deployment",
          readOnly: true,
        },
      ]);
      const deploymentVolume = yield* required(
        pod.volumes?.find(({ name }) => name === "deployment"),
        "Missing deployment volume",
      );
      const adminVolume = yield* required(
        pod.volumes?.find(({ name }) => name === "admin"),
        "Missing admin volume",
      );
      assert.strictEqual(adminVolume.secret?.defaultMode, 0o440);
      assert.strictEqual(deploymentVolume.configMap?.name, "openfga-deployment");
      assert.isTrue(deploymentVolume.configMap?.optional);

      assert.strictEqual((yield* disruption(resources)).spec.minAvailable, 1);
      assert.isTrue(
        (yield* bootstrapService(resources)).spec.publishNotReadyAddresses,
      );
      assert.isUndefined((yield* service(resources)).spec.publishNotReadyAddresses);

      const bootstrapJob = yield* bootstrap(resources);
      const bootstrapPod = bootstrapJob.spec.template.spec;
      assert.strictEqual(bootstrapPod.serviceAccountName, "openfga-bootstrap");
      assert.deepInclude(bootstrapPod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
      });
      assert.strictEqual(bootstrapPod.volumes?.[0]?.secret?.defaultMode, 0o440);
      assert.deepStrictEqual(bootstrapPod.containers[0]?.command, [
        "agentos-openfga-bootstrap",
      ]);
    }));

  it.effect("keeps admin material out of manifests and admits only selected core clients", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.isEmpty(resources.filter(({ kind }) =>
        kind === "Secret" || kind === "Ingress"
      ));
      for (const forbidden of ["firstmate", "secondmate", "crewmate"]) {
        assert.isFalse(containsText(resources, forbidden));
      }

      const networkPolicy = yield* policy(resources);
      assert.deepStrictEqual(networkPolicy.spec.policyTypes, ["Ingress"]);
      assert.deepStrictEqual(networkPolicy.spec.podSelector, {
        matchLabels: { "app.kubernetes.io/name": "openfga" },
      });
      assert.isUndefined(networkPolicy.spec.egress);
      const clientIngress = yield* required(
        networkPolicy.spec.ingress.find((entry) =>
          entry.ports.some(({ port }) => port === 8080)
        ),
        "Missing OpenFGA client ingress",
      );
      assert.deepStrictEqual(clientIngress, {
        from: [{
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "agentos" },
          },
          podSelector: {
            matchLabels: { "agentos.akua.dev/openfga-client": "true" },
          },
        }],
        ports: [
          { port: 8080, protocol: "TCP" },
          { port: 8081, protocol: "TCP" },
        ],
      });
    }));
});
