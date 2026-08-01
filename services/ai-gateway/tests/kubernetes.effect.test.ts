import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);
const Container = Schema.Struct({
  name: Schema.String,
  command: Schema.optional(Schema.Array(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  workingDir: Schema.optional(Schema.String),
  ports: Schema.optional(Schema.Unknown),
  volumeMounts: Schema.optional(Schema.Unknown),
  livenessProbe: Schema.optional(Schema.Struct({ httpGet: Schema.Unknown })),
  readinessProbe: Schema.optional(Schema.Struct({ httpGet: Schema.Unknown })),
  securityContext: Schema.optional(Schema.Unknown),
  env: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    value: Schema.optional(Schema.String),
    valueFrom: Schema.optional(Schema.Unknown),
  }))),
});
const StatefulSetSpec = Schema.Struct({
  replicas: Schema.Number,
  serviceName: Schema.String,
  persistentVolumeClaimRetentionPolicy: Schema.Unknown,
  volumeClaimTemplates: Schema.Unknown,
  template: Schema.Struct({
    spec: Schema.Struct({
      automountServiceAccountToken: Schema.Boolean,
      securityContext: Schema.Unknown,
      initContainers: Schema.Unknown,
      containers: Schema.Array(Container),
      volumes: Schema.Unknown,
    }),
  }),
});

class ManifestAssertionError extends Schema.TaggedErrorClass<ManifestAssertionError>()(
  "ManifestAssertionError",
  { message: Schema.String },
) {}

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

const render = Effect.fn("test.aiGateway.renderKustomize")(function*() {
  const command = ChildProcess.make(
    "kubectl",
    ["kustomize", `${repository}/services/ai-gateway/kubernetes`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* command;
    const [exitCode, stdout, stderr] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stdout, stderr };
  }));
  assert.deepStrictEqual(
    { exitCode: result.exitCode, stderr: result.stderr },
    { exitCode: 0, stderr: "" },
  );
  const parsed = yield* Effect.try({
    try: () =>
      parseAllDocuments(result.stdout).map((document) => document.toJSON()),
    catch: (cause) => cause,
  });
  return yield* Schema.decodeUnknownEffect(Resources)(parsed);
});

const findResource = Effect.fn("test.aiGateway.findResource")(
  function*(
    resources: typeof Resources.Type,
    kind: string,
    name: string,
  ) {
    const value = resources.find((candidate) =>
      candidate.kind === kind && candidate.metadata.name === name
    );
    if (value === undefined) {
      return yield* ManifestAssertionError.make({
        message: `Missing ${kind}/${name}`,
      });
    }
    return value;
  },
);

describe("optional Fleet AI Gateway", () => {
  it.effect("renders a private Effect service with retained state and bounded settlement identity", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) =>
          `${kind}/${metadata.name}`
        ).sort(),
        [
          "NetworkPolicy/ai-gateway",
          "Service/ai-gateway",
          "ServiceAccount/ai-gateway",
          "StatefulSet/ai-gateway",
        ],
      );

      const service = yield* findResource(resources, "Service", "ai-gateway");
      assert.deepStrictEqual(service.spec, {
        ports: [{
          name: "http",
          port: 8787,
          protocol: "TCP",
          targetPort: "http",
        }],
        selector: { "app.kubernetes.io/name": "ai-gateway" },
        type: "ClusterIP",
      });

      const statefulSet = yield* findResource(
        resources,
        "StatefulSet",
        "ai-gateway",
      );
      const spec = yield* Schema.decodeUnknownEffect(StatefulSetSpec)(
        statefulSet.spec,
      );
      assert.strictEqual(spec.replicas, 1);
      assert.strictEqual(spec.serviceName, "ai-gateway");
      assert.deepStrictEqual(spec.persistentVolumeClaimRetentionPolicy, {
        whenDeleted: "Retain",
        whenScaled: "Retain",
      });
      assert.deepStrictEqual(spec.volumeClaimTemplates, [{
        metadata: { name: "state" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      }]);

      const pod = spec.template.spec;
      assert.strictEqual(pod.automountServiceAccountToken, false);
      assert.deepStrictEqual(pod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1000,
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.deepStrictEqual(pod.initContainers, [{
        name: "state-permissions",
        image: "agentos:dev",
        imagePullPolicy: "Never",
        command: ["bun"],
        args: [
          "-e",
          'const { chmod, chown } = await import("node:fs/promises"); const path = "/var/lib/ai-gateway"; await chown(path, 0, 0); await chmod(path, 0o700); await chown(path, 1000, 1000);',
        ],
        volumeMounts: [{
          mountPath: "/var/lib/ai-gateway",
          name: "state",
        }],
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { add: ["CHOWN"], drop: ["ALL"] },
          readOnlyRootFilesystem: true,
          runAsGroup: 0,
          runAsNonRoot: false,
          runAsUser: 0,
        },
      }]);

      assert.lengthOf(pod.containers, 1);
      const container = pod.containers[0];
      if (container === undefined) {
        return yield* ManifestAssertionError.make({
          message: "Missing AI Gateway container",
        });
      }
      assert.deepStrictEqual(container.command, ["ai-gateway"]);
      assert.deepStrictEqual(container.args, ["serve"]);
      assert.isUndefined(container.workingDir);
      assert.deepStrictEqual(container.ports, [{
        containerPort: 8787,
        name: "http",
        protocol: "TCP",
      }]);
      assert.deepStrictEqual(container.volumeMounts, [
        { mountPath: "/var/lib/ai-gateway", name: "state" },
        {
          mountPath: "/var/run/secrets/agentos-budget-settlement",
          name: "budget-settlement",
          readOnly: true,
        },
      ]);
      assert.deepStrictEqual(container.livenessProbe?.httpGet, {
        path: "/healthz",
        port: "http",
      });
      assert.deepStrictEqual(container.readinessProbe?.httpGet, {
        path: "/readyz",
        port: "http",
      });
      assert.deepStrictEqual(container.securityContext, {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        readOnlyRootFilesystem: true,
      });
      const environment = Object.fromEntries(
        (container.env ?? []).map((entry) => [
          entry.name,
          entry.value ?? entry.valueFrom,
        ]),
      );
      assert.strictEqual(
        environment.AI_GATEWAY_STATE_DIR,
        "/var/lib/ai-gateway",
      );
      assert.strictEqual(
        environment.AI_GATEWAY_CLIENT_AUTH_MODE,
        "workload_identity",
      );
      assert.deepStrictEqual(environment.AI_GATEWAY_OPERATOR_TOKEN, {
        secretKeyRef: { key: "token", name: "ai-gateway-operator" },
      });
      assert.strictEqual(
        environment.AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL,
        "http://agentos-egress-authz.agentos.svc.cluster.local:9001",
      );
      assert.strictEqual(
        environment.AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_FILE,
        "/var/run/secrets/agentos-budget-settlement/token",
      );
      assert.isUndefined(environment.AI_GATEWAY_TOKEN);
      assert.isUndefined(environment.OPENAI_API_KEY);
      assert.isUndefined(environment.AI_GATEWAY_ALLOW_API_KEY_FALLBACK);
      assert.deepStrictEqual(pod.volumes, [{
        name: "budget-settlement",
        projected: {
          defaultMode: 288,
          sources: [{
            serviceAccountToken: {
              audience: "agentos-provider-budget-settlement",
              expirationSeconds: 600,
              path: "token",
            },
          }],
        },
      }]);

      const policy = yield* findResource(
        resources,
        "NetworkPolicy",
        "ai-gateway",
      );
      assert.deepStrictEqual(policy.spec, {
        ingress: [{
          from: [{
            podSelector: {
              matchLabels: {
                "agentos.akua.dev/ai-gateway-upstream": "true",
              },
            },
          }],
          ports: [{ port: 8787, protocol: "TCP" }],
        }],
        podSelector: {
          matchLabels: { "app.kubernetes.io/name": "ai-gateway" },
        },
        policyTypes: ["Ingress"],
      });
      assert.deepStrictEqual(
        resources.filter(({ kind }) => ["Ingress", "Secret"].includes(kind)),
        [],
      );
    }).pipe(Effect.provide(platform)));
});
