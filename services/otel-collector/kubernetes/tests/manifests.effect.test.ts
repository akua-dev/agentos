import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";

import { renderKustomize } from "../../../../tooling/testing/kubernetes.ts";

const Metadata = Schema.Struct({
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Rule = Schema.Struct({
  apiGroups: Schema.Array(Schema.String),
  resources: Schema.Array(Schema.String),
  verbs: Schema.Array(Schema.String),
});
const Resource = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Metadata,
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  rules: Schema.optional(Schema.Array(Rule)),
  roleRef: Schema.optional(Schema.Unknown),
  subjects: Schema.optional(Schema.Unknown),
  spec: Schema.optional(Schema.Unknown),
});
type Resource = typeof Resource.Type;
const Resources = Schema.Array(Resource);
const CollectorStatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Metadata,
  spec: Schema.Struct({
    replicas: Schema.Number,
    serviceName: Schema.String,
    persistentVolumeClaimRetentionPolicy: Schema.Unknown,
    volumeClaimTemplates: Schema.Unknown,
    template: Schema.Struct({
      spec: Schema.Struct({
        serviceAccountName: Schema.String,
        automountServiceAccountToken: Schema.Boolean,
        securityContext: Schema.Unknown,
        containers: Schema.Array(Schema.Struct({
          name: Schema.String,
          image: Schema.String,
          args: Schema.Array(Schema.String),
          env: Schema.Array(Schema.Unknown),
          ports: Schema.Array(Schema.Struct({
            containerPort: Schema.Number,
            name: Schema.String,
            protocol: Schema.String,
          })),
          livenessProbe: Schema.Struct({ httpGet: Schema.Unknown }),
          readinessProbe: Schema.Struct({ httpGet: Schema.Unknown }),
          resources: Schema.Unknown,
          securityContext: Schema.Unknown,
          volumeMounts: Schema.Unknown,
        })),
        volumes: Schema.Unknown,
      }),
    }),
  }),
});

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.otelManifest.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const resource = Effect.fn("test.otelManifest.resource")(function*(
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

const collectorStatefulSet = Effect.fn("test.otelManifest.statefulSet")(
  (resources: ReadonlyArray<Resource>) =>
    resource(resources, "StatefulSet", "agentos-otel-collector").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectorStatefulSet)),
    ),
);

const config = Effect.fn("test.otelManifest.config")(function*(
  resources: ReadonlyArray<Resource>,
) {
  const configMap = yield* resource(
    resources,
    "ConfigMap",
    "agentos-otel-collector",
  );
  return yield* required(
    configMap.data?.["collector.yaml"],
    "Missing collector.yaml",
  );
});

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) return value.some((item) => containsText(item, text));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsText(item, text));
}

const kubernetesUrl = new URL("..", import.meta.url);
const baseDirectory = "base";
const remoteDirectory = "overlays/remote";
const remoteGrpcDirectory = "overlays/remote-grpc";
const localDirectory = "overlays/local-diagnostics";
const render = Effect.fn("test.otelManifest.render")(function*(relativeDirectory: string) {
  const paths = yield* Path.Path;
  const kubernetesDirectory = yield* paths.fromFileUrl(kubernetesUrl);
  const documents = yield* renderKustomize(
    paths.join(kubernetesDirectory, relativeDirectory),
  );
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});

describe("Fleet OpenTelemetry Collector", () => {
  it.effect("renders a standalone private Collector with retained storage", () =>
    Effect.gen(function*() {
      const resources = yield* render(baseDirectory);
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
        [
          "ClusterRole/agentos-otel-collector",
          "ClusterRoleBinding/agentos-otel-collector",
          "ConfigMap/agentos-otel-collector",
          "NetworkPolicy/agentos-otel-collector",
          "Service/agentos-otel-collector",
          "ServiceAccount/agentos-otel-collector",
          "StatefulSet/agentos-otel-collector",
        ],
      );
      assert.deepStrictEqual(
        (yield* resource(resources, "Service", "agentos-otel-collector")).spec,
        {
          type: "ClusterIP",
          selector: { "app.kubernetes.io/name": "agentos-otel-collector" },
          ports: [
            {
              name: "otlp-grpc",
              port: 4317,
              protocol: "TCP",
              targetPort: "otlp-grpc",
            },
            {
              name: "otlp-http",
              port: 4318,
              protocol: "TCP",
              targetPort: "otlp-http",
            },
            {
              name: "metrics",
              port: 8888,
              protocol: "TCP",
              targetPort: "metrics",
            },
            {
              name: "health",
              port: 13133,
              protocol: "TCP",
              targetPort: "health",
            },
          ],
        },
      );

      const statefulSet = yield* collectorStatefulSet(resources);
      const spec = statefulSet.spec;
      assert.strictEqual(spec.replicas, 1);
      assert.strictEqual(spec.serviceName, "agentos-otel-collector");
      assert.deepStrictEqual(spec.persistentVolumeClaimRetentionPolicy, {
        whenDeleted: "Retain",
        whenScaled: "Retain",
      });
      assert.deepStrictEqual(spec.volumeClaimTemplates, [{
        metadata: { name: "storage" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "5Gi" } },
        },
      }]);
      const pod = spec.template.spec;
      assert.strictEqual(pod.serviceAccountName, "agentos-otel-collector");
      assert.isTrue(pod.automountServiceAccountToken);
      assert.deepStrictEqual(pod.securityContext, {
        fsGroup: 10001,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 10001,
        runAsNonRoot: true,
        runAsUser: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.lengthOf(pod.containers, 1);
      const collector = yield* required(pod.containers[0], "Missing Collector");
      assert.strictEqual(
        collector.image,
        "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6",
      );
      assert.deepStrictEqual(collector.args, [
        "--config=file:/etc/otelcol/collector.yaml",
      ]);
      assert.deepStrictEqual(collector.ports, [
        { containerPort: 4317, name: "otlp-grpc", protocol: "TCP" },
        { containerPort: 4318, name: "otlp-http", protocol: "TCP" },
        { containerPort: 8888, name: "metrics", protocol: "TCP" },
        { containerPort: 13133, name: "health", protocol: "TCP" },
      ]);
      for (const port of collector.ports) {
        assert.isAtMost(port.name.length, 15);
      }
      assert.deepStrictEqual(collector.livenessProbe.httpGet, {
        path: "/healthz",
        port: "health",
      });
      assert.deepStrictEqual(collector.readinessProbe.httpGet, {
        path: "/healthz",
        port: "health",
      });
      assert.deepInclude(collector.env, {
        name: "AGENTOS_OTEL_TRACE_SAMPLING_PERCENTAGE",
        value: "100",
      });
      assert.deepInclude(collector.env, {
        name: "OTEL_RESOURCE_ATTRIBUTES",
        value:
          "agentos.fleet.name=default,deployment.environment.name=development,agentos.telemetry.contract.version=1",
      });
      assert.deepStrictEqual(collector.securityContext, {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        readOnlyRootFilesystem: true,
      });
      assert.deepStrictEqual(collector.volumeMounts, [
        { mountPath: "/etc/otelcol", name: "config", readOnly: true },
        { mountPath: "/var/lib/otelcol", name: "storage" },
      ]);
      assert.deepStrictEqual(pod.volumes, [{
        configMap: { name: "agentos-otel-collector" },
        name: "config",
      }]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("limits metadata RBAC and OTLP ingress to labeled AgentOS clients", () =>
    Effect.gen(function*() {
      const resources = yield* render(baseDirectory);
      const role = yield* resource(
        resources,
        "ClusterRole",
        "agentos-otel-collector",
      );
      assert.deepStrictEqual(role.rules, [
        {
          apiGroups: [""],
          resources: ["namespaces", "pods"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: ["apps"],
          resources: ["daemonsets", "deployments", "replicasets", "statefulsets"],
          verbs: ["get", "list", "watch"],
        },
      ]);
      assert.deepInclude(
        (yield* resource(
          resources,
          "NetworkPolicy",
          "agentos-otel-collector",
        )).spec,
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "agentos-otel-collector",
            },
          },
          policyTypes: ["Ingress", "Egress"],
          ingress: [{
            from: [{
              namespaceSelector: {
                matchLabels: { "agentos.akua.dev/fleet": "default" },
              },
              podSelector: {
                matchLabels: { "agentos.akua.dev/otel-client": "true" },
              },
            }],
            ports: [
              { port: 4317, protocol: "TCP" },
              { port: 4318, protocol: "TCP" },
            ],
          }, {
            from: [{
              podSelector: {
                matchLabels: {
                  "agentos.akua.dev/observability-admin": "true",
                },
              },
            }],
            ports: [
              { port: 8888, protocol: "TCP" },
              { port: 13133, protocol: "TCP" },
            ],
          }],
        },
      );
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("keeps remote credentials out of rendered manifests", () =>
    Effect.gen(function*() {
      const resources = yield* render(remoteDirectory);
      assert.isTrue(containsText(resources, "agentos-otel-remote"));
      assert.isTrue(containsText(resources, "OTEL_EXPORTER_OTLP_ENDPOINT"));
      assert.isTrue(containsText(resources, "headers.yaml"));
      assert.isFalse(containsText(resources, "Bearer "));
      assert.isFalse(containsText(resources, "api-key"));
      const collectorConfig = yield* config(resources);
      assert.include(collectorConfig, "otlp_http/remote:");
      assert.include(collectorConfig, "storage: file_storage/queue");
      assert.include(collectorConfig, "sizer: requests");
      assert.include(collectorConfig, "wait_for_result: false");
      assert.include(collectorConfig, "block_on_overflow: false");
      assert.notInclude(collectorConfig, "file/local:");
      const statefulSet = yield* collectorStatefulSet(resources);
      const collector = yield* required(
        statefulSet.spec.template.spec.containers[0],
        "Missing Collector",
      );
      assert.deepStrictEqual(collector.args, [
        "--config=file:/etc/otelcol/collector.yaml",
        "--config=file:/etc/otelcol-secret/headers.yaml",
      ]);
      assert.deepInclude(collector.volumeMounts, {
        mountPath: "/etc/otelcol-secret",
        name: "remote-headers",
        readOnly: true,
      });
      assert.deepInclude(statefulSet.spec.template.spec.volumes, {
        name: "remote-headers",
        secret: {
          defaultMode: 288,
          items: [{ key: "headers.yaml", path: "headers.yaml" }],
          secretName: "agentos-otel-remote",
        },
      });
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("provides a Secret-backed OTLP/gRPC remote mode without image rebuilds", () =>
    Effect.gen(function*() {
      const resources = yield* render(remoteGrpcDirectory);
      const collectorConfig = yield* config(resources);
      assert.include(collectorConfig, "otlp_grpc/remote:");
      assert.notInclude(collectorConfig, "otlp_http/remote:");
      assert.include(collectorConfig, "storage: file_storage/queue");
      assert.isTrue(containsText(resources, "OTEL_EXPORTER_OTLP_ENDPOINT"));
      assert.isTrue(containsText(resources, "headers.yaml"));
      assert.isFalse(containsText(resources, "Bearer "));
      assert.isFalse(containsText(resources, "api-key"));
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("enables a separately provisioned bounded local archive only in its explicit overlay", () =>
    Effect.gen(function*() {
      const [base, local] = yield* Effect.all([
        render(baseDirectory),
        render(localDirectory),
      ], { concurrency: "unbounded" });
      assert.notInclude(yield* config(base), "file/local:");
      const localConfig = yield* config(local);
      assert.include(localConfig, "file/local:");
      assert.include(localConfig, "max_megabytes: 32");
      assert.include(localConfig, "max_backups: 8");
      assert.include(localConfig, "max_days: 1");
      const diagnostics = yield* resource(
        local,
        "PersistentVolumeClaim",
        "agentos-otel-diagnostics",
      );
      assert.deepStrictEqual(diagnostics.spec, {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "512Mi" } },
      });
      const statefulSet = yield* collectorStatefulSet(local);
      const collector = yield* required(
        statefulSet.spec.template.spec.containers[0],
        "Missing Collector",
      );
      assert.deepInclude(collector.volumeMounts, {
        mountPath: "/var/lib/otelcol-diagnostics",
        name: "diagnostics",
      });
      assert.deepInclude(statefulSet.spec.template.spec.volumes, {
        name: "diagnostics",
        persistentVolumeClaim: { claimName: "agentos-otel-diagnostics" },
      });
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("publishes safe operational status without coupling serving readiness", () =>
    Effect.gen(function*() {
      const resources = yield* render(baseDirectory);
      const collectorConfig = yield* config(resources);
      assert.include(collectorConfig, "path: /healthz");
      assert.include(collectorConfig, 'healthy: \'{\"status\":\"ok\"}\'');
      assert.include(
        collectorConfig,
        'unhealthy: \'{\"status\":\"unavailable\"}\'',
      );
      assert.include(collectorConfig, "host: 0.0.0.0");
      assert.include(collectorConfig, "port: 8888");
      assert.notInclude(collectorConfig, "authorization:");
      assert.notInclude(collectorConfig, "api_key:");
    }).pipe(Effect.provide(BunServices.layer)));
});
