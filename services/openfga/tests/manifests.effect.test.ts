import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { execFile } from "node:child_process";
import { parseAllDocuments } from "yaml";

const ResourceSchema = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
    labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  spec: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type Resource = typeof ResourceSchema.Type;

const kubernetesDirectory = new URL("../kubernetes", import.meta.url).pathname;

const render = Effect.fn("agentos.openfga.test.render")(function*() {
  const stdout = yield* Effect.tryPromise({
    try: (signal) => new Promise<string>((resolve, reject) => {
      const child = execFile(
        "kubectl",
        ["kustomize", kubernetesDirectory],
        { maxBuffer: 4 * 1_024 * 1_024 },
        (error, output) => error === null ? resolve(output) : reject(error),
      );
      signal.addEventListener("abort", () => child.kill("SIGTERM"), {
        once: true,
      });
    }),
    catch: (cause) => cause instanceof Error ? cause : new Error("render failed"),
  });
  return yield* Schema.decodeUnknownEffect(Schema.Array(ResourceSchema))(
    parseAllDocuments(stdout).map((document) => document.toJSON()),
  );
});

function resource(resources: ReadonlyArray<Resource>, kind: string, name: string) {
  const match = resources.find((item) =>
    item.kind === kind && item.metadata.name === name
  );
  assert.isDefined(match, `missing ${kind}/${name}`);
  return match!;
}

describe("OpenFGA Kubernetes topology", () => {
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

      const database = resource(resources, "Cluster", "openfga-postgres");
      assert.strictEqual(database.spec?.instances, 3);
      assert.strictEqual((database.spec as any).bootstrap.initdb.database, "openfga");
      assert.strictEqual((database.spec as any).bootstrap.initdb.owner, "openfga");
      assert.deepStrictEqual((database.spec as any).backup, {
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

      const migration = resource(resources, "Job", "openfga-migrate-v1-18-1");
      const migrationPod = (migration.spec as any).template.spec;
      assert.isFalse(migrationPod.automountServiceAccountToken);
      assert.strictEqual(
        migrationPod.containers[0].image,
        "docker.io/openfga/openfga@sha256:efde89d24487da1a8bc37d85b61341f1fb7024943a1ded65f4b7d51a75666688",
      );
      assert.deepStrictEqual(migrationPod.containers[0].args, [
        "migrate",
      ]);

      const deployment = resource(resources, "Deployment", "openfga");
      assert.strictEqual(deployment.spec?.replicas, 2);
      assert.deepNestedInclude(deployment.spec, {
        strategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
        },
      });
      const pod = (deployment.spec as any).template.spec;
      assert.isFalse(pod.automountServiceAccountToken);
      assert.lengthOf(pod.containers, 2);
      const runtime = pod.containers.find(({ name }: { name: string }) =>
        name === "openfga"
      );
      const readiness = pod.containers.find(({ name }: { name: string }) =>
        name === "semantic-readiness"
      );
      assert.strictEqual(
        runtime.image,
        "docker.io/openfga/openfga@sha256:efde89d24487da1a8bc37d85b61341f1fb7024943a1ded65f4b7d51a75666688",
      );
      assert.deepNestedInclude(
        Object.fromEntries(runtime.env.map((entry: any) => [entry.name, entry.value ?? entry.valueFrom])),
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
      assert.deepStrictEqual(runtime.readinessProbe.httpGet, {
        path: "/readyz",
        port: "semantic",
      });
      assert.deepStrictEqual(readiness.command, ["agentos-openfga-readiness"]);
      assert.deepStrictEqual(readiness.volumeMounts, [
        { mountPath: "/var/run/secrets/agentos-openfga", name: "admin", readOnly: true },
        { mountPath: "/var/run/agentos/openfga-deployment", name: "deployment", readOnly: true },
      ]);
      const deploymentVolume = pod.volumes.find(({ name }: { name: string }) =>
        name === "deployment"
      );
      assert.strictEqual(deploymentVolume.configMap.name, "openfga-deployment");
      assert.isTrue(deploymentVolume.configMap.optional);

      const disruption = resource(resources, "PodDisruptionBudget", "openfga");
      assert.strictEqual(disruption.spec?.minAvailable, 1);

      const bootstrapService = resource(resources, "Service", "openfga-bootstrap");
      assert.isTrue(bootstrapService.spec?.publishNotReadyAddresses);
      const service = resource(resources, "Service", "openfga");
      assert.notProperty(service.spec!, "publishNotReadyAddresses");

      const bootstrap = resource(
        resources,
        "Job",
        "openfga-bootstrap-agentos-access-v1",
      );
      const bootstrapPod = (bootstrap.spec as any).template.spec;
      assert.strictEqual(bootstrapPod.serviceAccountName, "openfga-bootstrap");
      assert.deepStrictEqual(bootstrapPod.containers[0].command, [
        "agentos-openfga-bootstrap",
      ]);
    }));

  it.effect("keeps admin material out of manifests and admits only selected core clients", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.isEmpty(resources.filter(({ kind }) =>
        kind === "Secret" || kind === "Ingress"
      ));
      const source = JSON.stringify(resources);
      assert.notInclude(source, "firstmate");
      assert.notInclude(source, "secondmate");
      assert.notInclude(source, "crewmate");

      const policy = resource(resources, "NetworkPolicy", "openfga");
      assert.deepNestedInclude(policy.spec, {
        policyTypes: ["Ingress"],
        podSelector: {
          matchLabels: { "app.kubernetes.io/name": "openfga" },
        },
      });
      assert.notProperty(policy.spec!, "egress");
      const ingress = (policy.spec as any).ingress;
      const clientIngress = ingress.find((entry: any) =>
        entry.ports.some(({ port }: { port: number }) => port === 8080)
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
