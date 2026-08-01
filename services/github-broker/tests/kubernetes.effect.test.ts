import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parseAllDocuments } from "yaml";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
  }),
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

const render = Effect.fn("test.githubBroker.renderKustomize")(
  function*(directory: string) {
    const command = ChildProcess.make(
      "kubectl",
      ["kustomize", `${repository}/${directory}`],
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
  },
);

describe("GitHub broker Kubernetes boundary", () => {
  it.effect("mounts the GitHub App credential only in the broker deployment", () =>
    Effect.gen(function*() {
      const resources = yield* render("services/github-broker/kubernetes");
      const deployment = resources.find((resource) =>
        resource.kind === "Deployment" && resource.metadata.name ===
          "github-broker"
      );
      const serviceAccount = resources.find((resource) =>
        resource.kind === "ServiceAccount" && resource.metadata.name ===
          "github-broker"
      );
      const rendered = JSON.stringify(resources);
      assert.isDefined(deployment);
      assert.isDefined(serviceAccount);
      assert.include(rendered, '"secretName":"agentos-github-app"');
      assert.include(rendered, '"GITHUB_APP_PRIVATE_KEY_FILE"');
      assert.include(rendered, '"automountServiceAccountToken":false');
      assert.include(
        rendered,
        '"AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL"',
      );
      assert.include(
        rendered,
        '"value":"http://agentos-egress-authz.agentos.svc.cluster.local:9001"',
      );
      assert.include(rendered, '"audience":"agentos-provider-budget-settlement"');
      assert.include(rendered, '"expirationSeconds":600');
      assert.include(
        rendered,
        '"mountPath":"/var/run/secrets/agentos-budget-settlement"',
      );
      assert.include(rendered, '"path":"token"');
      assert.notInclude(rendered, "ClusterRole");
      assert.notInclude(rendered, "ClusterRoleBinding");
    }).pipe(Effect.provide(platform)));

  it.effect("gives every Mate type only workload identity and the public CA", () =>
    Effect.gen(function*() {
      for (const directory of [
        "packages/agentos/resources/roles/firstmate/kubernetes/base",
        "packages/agentos/resources/roles/secondmate/kubernetes/base",
        "packages/agentos/resources/crewmates/default/kubernetes/base",
      ]) {
        const resources = yield* render(directory);
        const rendered = JSON.stringify(resources);
        assert.include(rendered, '"AGENTOS_GITHUB_PROVIDER_MODE"');
        assert.include(rendered, '"prepare-github-provider"');
        assert.include(rendered, '"agentos-egress-identity"');
        assert.include(rendered, '"configMap":{"defaultMode":292');
        assert.notInclude(rendered, '"secretName":"agentos-github-app"');
        assert.notInclude(rendered, '"GITHUB_APP_PRIVATE_KEY_FILE"');
        assert.notInclude(rendered, '"GITHUB_APP_ID"');
      }
    }).pipe(Effect.provide(platform)));
});
