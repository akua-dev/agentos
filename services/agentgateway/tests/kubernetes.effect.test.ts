import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parseAllDocuments } from "yaml";

const ResourceSchema = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
  }),
  spec: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  immutable: Schema.optional(Schema.Boolean),
  automountServiceAccountToken: Schema.optional(Schema.Boolean),
});

const ProbeSchema = Schema.Struct({
  httpGet: Schema.Struct({
    path: Schema.String,
    port: Schema.Union([Schema.String, Schema.Number]),
  }),
});

const ContainerSchema = Schema.Struct({
  name: Schema.String,
  image: Schema.String,
  command: Schema.optional(Schema.Array(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  livenessProbe: Schema.optional(ProbeSchema),
  readinessProbe: Schema.optional(ProbeSchema),
  startupProbe: Schema.optional(ProbeSchema),
  volumeMounts: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    mountPath: Schema.String,
    readOnly: Schema.optional(Schema.Boolean),
  }))),
});

const DeploymentSpecSchema = Schema.Struct({
  replicas: Schema.Literal(2),
  selector: Schema.Struct({
    matchLabels: Schema.Record(Schema.String, Schema.String),
  }),
  strategy: Schema.Struct({
    type: Schema.Literal("RollingUpdate"),
    rollingUpdate: Schema.Struct({
      maxSurge: Schema.Literal(1),
      maxUnavailable: Schema.Literal(0),
    }),
  }),
  template: Schema.Struct({
    spec: Schema.Struct({
      automountServiceAccountToken: Schema.Literal(false),
      serviceAccountName: Schema.String,
      topologySpreadConstraints: Schema.Array(Schema.Unknown),
      containers: Schema.Array(ContainerSchema),
      volumes: Schema.Array(Schema.Struct({
        name: Schema.String,
        secret: Schema.optional(Schema.Struct({ secretName: Schema.String })),
      })),
    }),
  }),
});

const PdbSpecSchema = Schema.Struct({ minAvailable: Schema.Literal(1) });
const NetworkPolicySpecSchema = Schema.Struct({
  policyTypes: Schema.Tuple([Schema.Literal("Ingress")]),
});
const repositoryRoot = new URL("../../..", import.meta.url);

const render = Effect.fn("test.agentgateway.renderKustomize")(function*() {
  const paths = yield* Path.Path;
  const root = yield* paths.fromFileUrl(repositoryRoot);
  const child = yield* ChildProcess.make(
    "kubectl",
    ["kustomize", "services/agentgateway/kubernetes"],
    { cwd: root, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr, stdout] = yield* Effect.all([
    child.exitCode.pipe(Effect.map(Number)),
    child.stderr.pipe(Stream.decodeText(), Stream.mkString),
    child.stdout.pipe(Stream.decodeText(), Stream.mkString),
  ], { concurrency: "unbounded" });
  assert.strictEqual(exitCode, 0, stderr);
  return stdout;
});

const resourcesFrom = Effect.fn("test.agentgateway.resourcesFrom")(
  function*(manifest: string) {
    const resources = yield* Effect.try({
      try: () => parseAllDocuments(manifest).map((document) => document.toJS()),
      catch: (cause) => cause,
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(ResourceSchema))(
      resources,
    );
  },
);

describe("owned agentgateway Kustomize workloads", () => {
  it.effect("renders split, credentialless, disruption-safe PEPs", () =>
    Effect.scoped(Effect.gen(function*() {
      const manifest = yield* render();
      const resources = yield* resourcesFrom(manifest);
      const deployments = resources.filter(({ kind }) => kind === "Deployment");
      assert.deepStrictEqual(
        deployments.map(({ metadata }) => metadata.name).sort(),
        ["agentgateway-github", "agentgateway-openai"],
      );

      for (const deployment of deployments) {
        const spec = yield* Schema.decodeUnknownEffect(DeploymentSpecSchema)(
          deployment.spec,
        );
        const gateway = spec.template.spec.containers.find(
          ({ name }) => name === "agentgateway",
        );
        const readiness = spec.template.spec.containers.find(
          ({ name }) => name === "semantic-readiness",
        );
        assert.strictEqual(
          gateway?.image,
          "cr.agentgateway.dev/agentgateway@sha256:efd79355b89094a8225a9db465d9a01dc656b377f0bab458761b935a13231d29",
        );
        assert.strictEqual(gateway?.readinessProbe?.httpGet.path, "/readyz");
        assert.strictEqual(gateway?.readinessProbe?.httpGet.port, 15022);
        assert.strictEqual(gateway?.livenessProbe?.httpGet.path, "/healthz/ready");
        assert.strictEqual(gateway?.startupProbe?.httpGet.path, "/healthz/ready");
        assert.strictEqual(readiness?.image, "agentos:dev");
        assert.deepStrictEqual(readiness?.command, [
          "agentos-agentgateway-readiness",
        ]);
        assert.strictEqual(readiness?.readinessProbe?.httpGet.path, "/readyz");
        assert.isUndefined(
          spec.selector.matchLabels["app.kubernetes.io/version"],
        );

        const secrets = spec.template.spec.volumes.flatMap(({ secret }) =>
          secret === undefined ? [] : [secret.secretName]
        );
        assert.deepStrictEqual(
          secrets,
          deployment.metadata.name === "agentgateway-github"
            ? ["agentos-github-tls"]
            : [],
        );
      }

      const serviceAccounts = resources.filter(
        ({ kind }) => kind === "ServiceAccount",
      );
      assert.lengthOf(serviceAccounts, 2);
      assert.isTrue(
        serviceAccounts.every(
          ({ automountServiceAccountToken }) =>
            automountServiceAccountToken === false,
        ),
      );

      const disruptionBudgets = resources.filter(
        ({ kind }) => kind === "PodDisruptionBudget",
      );
      assert.lengthOf(disruptionBudgets, 2);
      yield* Effect.forEach(disruptionBudgets, ({ spec }) =>
        Schema.decodeUnknownEffect(PdbSpecSchema)(spec));

      const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
      assert.lengthOf(policies, 2);
      yield* Effect.forEach(policies, ({ spec }) =>
        Schema.decodeUnknownEffect(NetworkPolicySpecSchema)(spec));
      assert.notInclude(manifest, "policyTypes:\n  - Egress");
      assert.notInclude(manifest, "kind: Secret");
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("rolls immutable route configuration through generated ConfigMaps", () =>
    Effect.scoped(Effect.gen(function*() {
      const resources = yield* render().pipe(Effect.flatMap(resourcesFrom));
      const configs = resources.filter(({ kind }) => kind === "ConfigMap");
      assert.lengthOf(configs, 2);
      for (const config of configs) {
        assert.strictEqual(config.immutable, true);
        assert.match(
          config.metadata.name,
          /^agentgateway-(?:github|openai)-config-[a-z0-9]+$/,
        );
        assert.include(config.data?.["config.yaml"] ?? "", "failureMode: deny");
        assert.include(config.data?.["config.yaml"] ?? "", "- traceparent");
        assert.notInclude(config.data?.["config.yaml"] ?? "", "database:");
      }
    }).pipe(Effect.provide(BunServices.layer))));
});
