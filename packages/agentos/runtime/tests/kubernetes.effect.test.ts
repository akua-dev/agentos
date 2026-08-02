import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../src/access/identity.ts";
import { renderKustomize } from "../../../../tooling/testing/kubernetes.ts";

const EnvironmentEntry = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});
const Container = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvironmentEntry)),
  livenessProbe: Schema.optional(Schema.Struct({
    exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
  })),
  readinessProbe: Schema.optional(Schema.Struct({
    exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
  })),
  securityContext: Schema.optional(Schema.Unknown),
  volumeMounts: Schema.optional(Schema.Unknown),
});
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);
const StatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.Struct({
    persistentVolumeClaimRetentionPolicy: Schema.Unknown,
    volumeClaimTemplates: Schema.Unknown,
    template: Schema.Struct({
      spec: Schema.Struct({
        securityContext: Schema.Unknown,
        initContainers: Schema.Array(Container),
        containers: Schema.Array(Container),
        volumes: Schema.Unknown,
      }),
    }),
  }),
});

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.runtimeKubernetes.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const kubernetes = fileURLToPath(new URL("../kubernetes", import.meta.url));
const render = Effect.fn("test.runtimeKubernetes.render")(function*(
  directory: string,
) {
  const documents = yield* renderKustomize(directory);
  const resources = yield* Schema.decodeUnknownEffect(Resources)(documents);
  return yield* required(
    resources.find(({ kind }) => kind === "StatefulSet"),
    "Missing StatefulSet",
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StatefulSet)));
});

function environment(container: typeof Container.Type) {
  return Object.fromEntries(
    (container.env ?? []).map(({ name, value }) => [name, value]),
  );
}

describe("persistent Agent Kubernetes runtime", () => {
  it.effect("keeps only retained-home and Herdr invariants in the neutral base", () =>
    Effect.gen(function*() {
      const workload = yield* render(join(kubernetes, "base"));
      assert.strictEqual(workload.metadata.name, "agentos-agent");
      assert.deepStrictEqual(
        workload.spec.persistentVolumeClaimRetentionPolicy,
        { whenDeleted: "Retain", whenScaled: "Retain" },
      );
      assert.deepStrictEqual(workload.spec.volumeClaimTemplates, [{
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      }]);

      const pod = workload.spec.template.spec;
      assert.deepStrictEqual(pod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1000,
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.lengthOf(pod.initContainers, 1);
      assert.lengthOf(pod.containers, 1);
      const install = yield* required(pod.initContainers[0], "Missing installer");
      const agent = yield* required(pod.containers[0], "Missing Agent");
      assert.deepStrictEqual(install.args, [
        "install",
        "--locked",
        "node",
        "kubectl",
        "github:ogulcancelik/herdr",
      ]);
      assert.deepStrictEqual(agent.command, ["herdr"]);
      assert.deepStrictEqual(agent.args, ["server", "--session", "agentos-agent"]);
      assert.isUndefined(environment(agent).PI_CODING_AGENT_DIR);
      assert.isUndefined(environment(agent).PI_OAUTH_CALLBACK_HOST);
      assert.deepStrictEqual(agent.securityContext, {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      });
      assert.deepStrictEqual(agent.volumeMounts, [
        { mountPath: "/home/agent", name: "home" },
        {
          mountPath: "/var/run/secrets/agentos-egress",
          name: "agentos-egress-identity",
          readOnly: true,
        },
      ]);
      assert.deepStrictEqual(install.volumeMounts, [
        { mountPath: "/home/agent", name: "home" },
      ]);
      assert.deepStrictEqual(pod.volumes, [{
        name: "agentos-egress-identity",
        projected: {
          defaultMode: 288,
          sources: [{
            serviceAccountToken: {
              audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
              expirationSeconds: AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
              path: "token",
            },
          }],
        },
      }]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("adds the persistent Pi lifecycle only in the Mate layer", () =>
    Effect.gen(function*() {
      const workload = yield* render(join(kubernetes, "mate"));
      assert.strictEqual(workload.metadata.name, "agentos-agent");
      const pod = workload.spec.template.spec;
      assert.lengthOf(pod.initContainers, 2);
      assert.lengthOf(pod.containers, 1);
      const install = yield* required(pod.initContainers[0], "Missing installer");
      const prepare = yield* required(pod.initContainers[1], "Missing prepare");
      const mate = yield* required(pod.containers[0], "Missing Mate");
      assert.deepStrictEqual(install.args, [
        "install",
        "--locked",
        "node",
        "kubectl",
        "github:ogulcancelik/herdr",
        "npm:@earendil-works/pi-coding-agent",
      ]);
      assert.deepStrictEqual(prepare.args, ["run", "--skip-tools", "mate:prepare"]);
      assert.deepStrictEqual(mate.command, ["mise"]);
      assert.deepStrictEqual(mate.args, ["run", "--skip-tools", "mate:run"]);
      assert.deepInclude(environment(mate), {
        PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
        PI_OAUTH_CALLBACK_HOST: "0.0.0.0",
      });
      assert.deepStrictEqual(mate.livenessProbe, {
        exec: { command: ["mise", "run", "--skip-tools", "mate:health", "--", "live"] },
      });
      assert.deepStrictEqual(mate.readinessProbe, {
        exec: { command: ["mise", "run", "--skip-tools", "mate:health", "--", "ready"] },
      });
    }).pipe(Effect.provide(BunServices.layer)));
});
