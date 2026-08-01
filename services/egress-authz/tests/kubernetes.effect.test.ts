import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const kubernetesDirectory = fileURLToPath(
  new URL("../kubernetes", import.meta.url),
);
const Resource = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
  }),
  rules: Schema.optional(Schema.Unknown),
  roleRef: Schema.optional(Schema.Unknown),
  subjects: Schema.optional(Schema.Unknown),
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

const render = Effect.fn("test.egressAuthz.renderKustomize")(function*() {
  const command = ChildProcess.make(
    "kubectl",
    ["kustomize", kubernetesDirectory],
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
  assert.strictEqual(result.exitCode, 0, result.stderr);
  const parsed = yield* Effect.try({
    try: () =>
      parseAllDocuments(result.stdout).map((document) => document.toJSON()),
    catch: (cause) => cause,
  });
  return yield* Schema.decodeUnknownEffect(Resources)(parsed);
});

describe("egress authorizer Kubernetes boundary", () => {
  it.effect("renders a private HA authorizer with file-projected secrets", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
        [
          "ClusterRole/agentos-egress-authz",
          "ClusterRoleBinding/agentos-egress-authz",
          "Deployment/agentos-egress-authz",
          "NetworkPolicy/agentos-egress-authz",
          "PodDisruptionBudget/agentos-egress-authz",
          "Service/agentos-egress-authz",
          "ServiceAccount/agentos-egress-authz",
        ].sort(),
      );
      const rendered = JSON.stringify(resources);
      assert.include(rendered, '"replicas":2');
      assert.include(rendered, '"command":["agentos-egress-authz"]');
      assert.include(rendered, '"automountServiceAccountToken":true');
      assert.include(rendered, '"agentos.akua.dev/openfga-client":"true"');
      assert.include(rendered, '"secretName":"agentos-postgres-app"');
      assert.include(rendered, '"key":"uri","path":"database-url"');
      assert.include(rendered, '"secretName":"openfga-admin"');
      assert.include(rendered, '"key":"preshared-key","path":"preshared-key"');
      assert.include(rendered, '"name":"openfga-deployment"');
      assert.notInclude(rendered, '"kind":"Secret"');
      assert.notInclude(rendered, '"kind":"Ingress"');
      assert.notInclude(rendered, '"valueFrom":{"secretKeyRef"');
    }).pipe(Effect.provide(platform)));

  it.effect("grants only identity review reads and keeps ordinary Internet egress", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      const rendered = JSON.stringify(resources);
      assert.include(rendered, '"resources":["tokenreviews"]');
      assert.include(rendered, '"verbs":["create"]');
      assert.include(rendered, '"resources":["pods","serviceaccounts"]');
      assert.include(rendered, '"verbs":["get"]');
      assert.include(rendered, '"policyTypes":["Ingress"]');
      assert.notInclude(rendered, '"policyTypes":["Ingress","Egress"]');
      assert.notInclude(rendered, '"egress":');
      assert.include(rendered, '"port":9001');
      assert.include(rendered, '"targetPort":"http"');
    }).pipe(Effect.provide(platform)));
});
