import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const serviceDirectory = fileURLToPath(
  new URL("../kubernetes", import.meta.url),
);
const gatewayDirectory = fileURLToPath(
  new URL("../../agentgateway/kubernetes/a2a", import.meta.url),
);
const ResourceSchema = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
});

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

const render = Effect.fn("test.a2a.renderKustomize")(function*(directory: string) {
  const command = ChildProcess.make(
    "kubectl",
    ["kustomize", directory],
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
  const documents = yield* Effect.try({
    try: () =>
      parseAllDocuments(result.stdout).map((document) => document.toJSON()),
    catch: (cause) => cause,
  });
  const resources = yield* Schema.decodeUnknownEffect(
    Schema.Array(ResourceSchema),
  )(documents);
  return { resources, source: result.stdout };
});

describe("A2A Kubernetes boundary", () => {
  it.effect("renders a private HA Effect service with projected identity", () =>
    Effect.gen(function*() {
      const rendered = yield* render(serviceDirectory);
      assert.deepStrictEqual(
        rendered.resources.map(({ kind, metadata }) =>
          `${kind}/${metadata.name}`
        ).sort(),
        [
          "ClusterRole/agentos-a2a",
          "ClusterRoleBinding/agentos-a2a",
          "ConfigMap/agentos-a2a-targets",
          "Deployment/agentos-a2a",
          "NetworkPolicy/agentos-a2a",
          "PodDisruptionBudget/agentos-a2a",
          "Service/agentos-a2a",
          "ServiceAccount/agentos-a2a",
        ].sort(),
      );
      assert.include(rendered.source, "replicas: 2");
      assert.include(rendered.source, "- agentos-a2a");
      assert.include(rendered.source, "audience: agentos-egress-authz");
      assert.include(rendered.source, "expirationSeconds: 600");
      assert.include(rendered.source, "secretName: agentos-a2a-database");
      assert.include(rendered.source, "secretName: openfga-admin");
      assert.include(rendered.source, "name: openfga-deployment");
      assert.include(rendered.source, "policyTypes:\n  - Ingress");
      assert.notInclude(rendered.source, "\n  egress:");
      assert.notInclude(rendered.source, "kind: Secret");
      assert.notInclude(rendered.source, "secretKeyRef:");
    }).pipe(Effect.provide(platform)));

  it.effect("renders A2A routing with public discovery and fail-closed RPC authorization", () =>
    Effect.gen(function*() {
      const rendered = yield* render(gatewayDirectory);
      assert.deepStrictEqual(
        rendered.resources.map(({ kind, metadata }) =>
          `${kind}/${metadata.name}`
        ).sort(),
        [
          "AgentgatewayBackend/agentos-a2a",
          "AgentgatewayPolicy/agentos-a2a-rpc",
          "Gateway/agentgateway-a2a",
          "HTTPRoute/agentos-a2a-public",
          "HTTPRoute/agentos-a2a-rpc",
        ].sort(),
      );
      assert.include(rendered.source, "host: agentos-a2a.agentos.svc.cluster.local");
      assert.include(rendered.source, "port: 8790");
      assert.include(rendered.source, "failureMode: FailClosed");
      assert.include(rendered.source, "maxSize: 16384");
      assert.include(rendered.source, "path: '\"/authorize\"'");
      assert.include(rendered.source, "x-agentos-original-method: request.method");
      assert.include(rendered.source, "x-agentos-original-path: request.path");
      assert.include(rendered.source, "- x-agentos-a2a-verified-agent-id");
      assert.include(rendered.source, "method: GET");
      assert.include(rendered.source, "method: POST");
    }).pipe(Effect.provide(platform)));
});
