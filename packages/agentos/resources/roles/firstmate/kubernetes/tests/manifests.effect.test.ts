import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../../../../src/access/identity.ts";
import {
  applyStrategicPatch,
  renderKustomize,
} from "../../../../../../../tooling/testing/kubernetes.ts";

const EnvironmentEntry = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  valueFrom: Schema.optional(Schema.Unknown),
});
type EnvironmentEntry = typeof EnvironmentEntry.Type;
const VolumeMount = Schema.Struct({
  mountPath: Schema.String,
  name: Schema.String,
  readOnly: Schema.optional(Schema.Boolean),
});
const Container = Schema.Struct({
  name: Schema.String,
  image: Schema.String,
  imagePullPolicy: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvironmentEntry)),
  volumeMounts: Schema.optional(Schema.Array(VolumeMount)),
  livenessProbe: Schema.optional(Schema.Struct({
    exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
  })),
  readinessProbe: Schema.optional(Schema.Struct({
    exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
  })),
  securityContext: Schema.optional(Schema.Unknown),
  resources: Schema.optional(Schema.Unknown),
});
const Metadata = Schema.Struct({
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Resource = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Metadata,
  spec: Schema.optional(Schema.Unknown),
  roleRef: Schema.optional(Schema.Unknown),
  subjects: Schema.optional(Schema.Unknown),
});
type Resource = typeof Resource.Type;
const Resources = Schema.Array(Resource);
const StatefulSet = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.Literal("StatefulSet"),
  metadata: Metadata,
  spec: Schema.Struct({
    replicas: Schema.Number,
    selector: Schema.Unknown,
    serviceName: Schema.String,
    persistentVolumeClaimRetentionPolicy: Schema.Unknown,
    volumeClaimTemplates: Schema.Array(Schema.Struct({
      metadata: Schema.Struct({ name: Schema.String }),
      spec: Schema.Unknown,
    })),
    template: Schema.Struct({
      metadata: Schema.Struct({
        annotations: Schema.optional(
          Schema.Record(Schema.String, Schema.String),
        ),
        labels: Schema.Record(Schema.String, Schema.String),
      }),
      spec: Schema.Struct({
        serviceAccountName: Schema.String,
        securityContext: Schema.Unknown,
        initContainers: Schema.Array(Container),
        containers: Schema.Array(Container),
        volumes: Schema.Array(Schema.Unknown),
      }),
    }),
  }),
});
type StatefulSet = typeof StatefulSet.Type;

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.firstMateManifest.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const resource = Effect.fn("test.firstMateManifest.resource")(function*(
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

const statefulSet = Effect.fn("test.firstMateManifest.statefulSet")(
  function*(resources: ReadonlyArray<Resource>) {
    return yield* resource(
      resources,
      "StatefulSet",
      "agentos-firstmate",
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StatefulSet)));
  },
);

function environment(entries: ReadonlyArray<EnvironmentEntry>) {
  return Object.fromEntries(
    entries.map(({ name, value, valueFrom }) => [name, value ?? valueFrom]),
  );
}

const runtime = fileURLToPath(new URL("..", import.meta.url));
const render = Effect.fn("test.firstMateManifest.render")(function*(
  directory: string,
) {
  const documents = yield* renderKustomize(directory, {
    loadRestrictionsNone: true,
  });
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(BunServices.layer));

describe("First Mate Kubernetes resources", () => {
  it.effect("renders one retained, non-root home with no public endpoint", () =>
    withPlatform(Effect.gen(function*() {
      const resources = yield* render(join(runtime, "base"));
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
        [
          "Namespace/agentos",
          "RoleBinding/agentos-firstmate-admin",
          "Service/agentos-firstmate",
          "ServiceAccount/agentos-firstmate",
          "StatefulSet/agentos-firstmate",
        ],
      );
      assert.deepStrictEqual(
        (yield* resource(resources, "Namespace", "agentos")).metadata.labels,
        { "agentos.akua.dev/fleet": "default" },
      );
      assert.deepStrictEqual(
        (yield* resource(resources, "Service", "agentos-firstmate")).spec,
        {
          clusterIP: "None",
          selector: { "app.kubernetes.io/name": "agentos-firstmate" },
        },
      );
      const roleBinding = yield* resource(
        resources,
        "RoleBinding",
        "agentos-firstmate-admin",
      );
      assert.deepStrictEqual(roleBinding.roleRef, {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "admin",
      });
      assert.deepStrictEqual(roleBinding.subjects, [{
        kind: "ServiceAccount",
        name: "agentos-firstmate",
        namespace: "agentos",
      }]);

      const workload = yield* statefulSet(resources);
      const spec = workload.spec;
      assert.strictEqual(spec.replicas, 1);
      assert.strictEqual(spec.serviceName, "agentos-firstmate");
      assert.deepStrictEqual(spec.persistentVolumeClaimRetentionPolicy, {
        whenDeleted: "Retain",
        whenScaled: "Retain",
      });
      assert.deepStrictEqual(spec.volumeClaimTemplates, [{
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      }]);
      const pod = spec.template.spec;
      assert.deepStrictEqual(spec.template.metadata, {
        annotations: {
          "agentos.akua.dev/container": "agentos",
          "agentos.akua.dev/herdr-session": "agentos-firstmate",
        },
        labels: {
          "agentos.akua.dev/agent": "firstmate",
          "agentos.akua.dev/github-client": "true",
          "agentos.akua.dev/otel-client": "true",
          "app.kubernetes.io/name": "agentos-firstmate",
          "app.kubernetes.io/part-of": "agentos",
        },
      });
      assert.deepStrictEqual(pod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1000,
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.lengthOf(pod.initContainers, 3);
      assert.lengthOf(pod.containers, 1);
      const install = yield* required(pod.initContainers[0], "Missing installer");
      const prepare = yield* required(pod.initContainers[1], "Missing prepare");
      const firstMate = yield* required(pod.containers[0], "Missing First Mate");
      assert.strictEqual(install.image, "agentos:dev");
      assert.strictEqual(prepare.image, install.image);
      assert.strictEqual(firstMate.image, install.image);
      assert.deepStrictEqual(
        [install, prepare, firstMate].map(({ workingDir }) => workingDir),
        [
          "/opt/agentos/packages/agentos/resources/roles/firstmate",
          "/opt/agentos/packages/agentos/resources/roles/firstmate",
          "/opt/agentos/packages/agentos/resources/roles/firstmate",
        ],
      );
      assert.deepStrictEqual(install.volumeMounts, [
        { mountPath: "/home/agent", name: "home" },
      ]);
      assert.deepStrictEqual(prepare.volumeMounts, install.volumeMounts);
      assert.deepStrictEqual(firstMate.volumeMounts, [
        ...(install.volumeMounts ?? []),
        {
          mountPath: "/var/run/secrets/agentos-egress",
          name: "agentos-egress-identity",
          readOnly: true,
        },
        {
          mountPath: "/var/run/config/agentos-github",
          name: "agentos-github-ca",
          readOnly: true,
        },
      ]);
      assert.deepStrictEqual(install.command, ["mise"]);
      assert.deepStrictEqual(install.args, [
        "install",
        "--locked",
        "node",
        "kubectl",
        "github:ogulcancelik/herdr",
        "npm:@earendil-works/pi-coding-agent",
      ]);
      assert.deepStrictEqual(prepare.command, ["mise"]);
      assert.deepStrictEqual(prepare.args, ["run", "--skip-tools", "firstmate:prepare"]);
      assert.deepStrictEqual(firstMate.command, ["mise"]);
      assert.deepStrictEqual(firstMate.args, ["run", "--skip-tools", "firstmate:run"]);
      const variables = environment(
        yield* required(firstMate.env, "Missing First Mate environment"),
      );
      assert.strictEqual(
        variables.AGENTOS_AGENT_CWD,
        "/home/agent/projects/agentos/packages/agentos/resources/roles/firstmate",
      );
      assert.strictEqual(
        variables.AGENTOS_DISTRIBUTION_ROOT,
        "/home/agent/projects/agentos/packages/agentos",
      );
      assert.strictEqual(variables.AGENTOS_AGENT_NAME, "firstmate");
      assert.strictEqual(variables.AGENTOS_AGENT_ROLE, "first_mate");
      assert.strictEqual(variables.AGENTOS_PROVIDER_CREDENTIAL_KIND, "pi_auth");
      assert.strictEqual(variables.NODE_PATH, "/opt/agentos/node_modules");
      assert.isUndefined(variables.AGENTOS_MODEL);
      assert.isUndefined(variables.AGENTOS_THINKING);
      assert.strictEqual(variables.PI_OAUTH_CALLBACK_HOST, "0.0.0.0");
      assert.deepStrictEqual(firstMate.livenessProbe, {
        exec: { command: ["mise", "run", "--skip-tools", "firstmate:health", "--", "live"] },
      });
      assert.deepStrictEqual(firstMate.readinessProbe, {
        exec: { command: ["mise", "run", "--skip-tools", "firstmate:health", "--", "ready"] },
      });
      assert.deepStrictEqual(firstMate.securityContext, {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      });
      assert.deepInclude(pod.volumes, {
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
      });
      assert.deepStrictEqual(
        resources.filter(({ kind }) =>
          ["Ingress", "LoadBalancer", "NodePort", "ClusterRoleBinding"].includes(kind)
        ),
        [],
      );
    })));

  it.effect("adds cluster-admin only through the dedicated-cluster overlay", () =>
    withPlatform(Effect.gen(function*() {
      const resources = yield* render(join(runtime, "overlays", "cluster-admin"));
      const binding = yield* resource(
        resources,
        "ClusterRoleBinding",
        "agentos-firstmate-cluster-admin",
      );
      assert.deepStrictEqual(binding.roleRef, {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "cluster-admin",
      });
      assert.deepStrictEqual(binding.subjects, [{
        kind: "ServiceAccount",
        name: "agentos-firstmate",
        namespace: "agentos",
      }]);
    })));

  it.effect("adds CNPG client identity without replacing live First Mate state", () =>
    withPlatform(Effect.gen(function*() {
      const original = yield* render(join(runtime, "base")).pipe(
        Effect.flatMap(statefulSet),
      );
      const liveImage = `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;
      const live: StatefulSet = {
        ...original,
        spec: {
          ...original.spec,
          template: {
            ...original.spec.template,
            spec: {
              ...original.spec.template.spec,
              initContainers: original.spec.template.spec.initContainers.map(
                (container) => ({
                  ...container,
                  image: liveImage,
                  imagePullPolicy: "IfNotPresent",
                }),
              ),
              containers: original.spec.template.spec.containers.map(
                (container) => container.name === "agentos"
                  ? {
                    ...container,
                    image: liveImage,
                    imagePullPolicy: "IfNotPresent",
                    env: [
                      ...(container.env ?? []),
                      { name: "EXISTING_RUNTIME_SETTING", value: "preserve-me" },
                    ],
                    volumeMounts: [
                      ...(container.volumeMounts ?? []),
                      {
                        mountPath: "/var/run/existing",
                        name: "existing-runtime",
                        readOnly: true,
                      },
                    ],
                  }
                  : { ...container, image: liveImage, imagePullPolicy: "IfNotPresent" },
              ),
              volumes: [{
                name: "existing-runtime",
                configMap: { name: "existing-runtime" },
              }],
            },
          },
        },
      };
      const patched = yield* applyStrategicPatch(
        live,
        join(runtime, "patches", "cloudnative-pg.yaml"),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(StatefulSet)));
      const pod = patched.spec.template.spec;
      const install = yield* required(pod.initContainers[0], "Missing installer");
      const prepare = yield* required(pod.initContainers[1], "Missing prepare");
      const firstMate = yield* required(pod.containers[0], "Missing First Mate");
      assert.deepStrictEqual(
        [install, prepare, firstMate].map(({ image }) => image),
        [liveImage, liveImage, liveImage],
      );
      assert.deepStrictEqual(
        [install, prepare, firstMate].map(({ imagePullPolicy }) => imagePullPolicy),
        ["IfNotPresent", "IfNotPresent", "IfNotPresent"],
      );
      assert.strictEqual(pod.serviceAccountName, "agentos-firstmate");
      assert.deepInclude(firstMate.volumeMounts ?? [], {
        mountPath: "/home/agent",
        name: "home",
      });
      assert.deepInclude(firstMate.volumeMounts ?? [], {
        mountPath: "/var/run/existing",
        name: "existing-runtime",
        readOnly: true,
      });
      assert.isFalse(
        (install.volumeMounts ?? []).some(({ name }) => name === "postgres-ca"),
      );
      assert.isFalse(
        (install.volumeMounts ?? []).some(({ name }) => name === "postgres-pgpass"),
      );
      assert.deepInclude(prepare.volumeMounts ?? [], {
        mountPath: "/var/run/agentos/postgres-credentials",
        name: "postgres-pgpass",
        readOnly: true,
      });
      assert.deepInclude(firstMate.volumeMounts ?? [], {
        mountPath: "/var/run/agentos/postgres",
        name: "postgres-ca",
        readOnly: true,
      });
      const variables = environment(
        yield* required(firstMate.env, "Missing First Mate environment"),
      );
      assert.deepInclude(variables, {
        AGENTOS_DATABASE_IDENTITY: "agentos",
        DATABASE_URL:
          "postgresql://agentos@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=verify-full",
        EXISTING_RUNTIME_SETTING: "preserve-me",
        NODE_EXTRA_CA_CERTS: "/var/run/agentos/postgres/ca.crt",
        PGPASSFILE: "/home/agent/.pgpass",
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/var/run/agentos/postgres/ca.crt",
      });
      assert.isUndefined(variables.PGPASSWORD);
      assert.strictEqual(
        environment(yield* required(prepare.env, "Missing prepare environment"))
          .AGENTOS_PGPASS_SOURCE,
        "/var/run/agentos/postgres-credentials/pgpass",
      );
      assert.deepInclude(pod.volumes, {
        name: "postgres-ca",
        secret: {
          defaultMode: 288,
          items: [{ key: "ca.crt", path: "ca.crt" }],
          secretName: "agentos-postgres-ca",
        },
      });
      assert.deepInclude(pod.volumes, {
        name: "postgres-pgpass",
        secret: {
          defaultMode: 288,
          items: [{ key: "pgpass", path: "pgpass" }],
          secretName: "agentos-postgres-app",
        },
      });
      assert.deepInclude(pod.volumes, {
        name: "existing-runtime",
        configMap: { name: "existing-runtime" },
      });
    })));

  it.effect("keeps tool installation ahead of home preparation when CNPG is composed with Kustomize", () =>
    withPlatform(Effect.gen(function*() {
      const workload = yield* render(
        join(runtime, "tests", "fixtures", "cloudnative-pg"),
      ).pipe(Effect.flatMap(statefulSet));
      assert.deepStrictEqual(
        workload.spec.template.spec.initContainers.map(({ name }) => name),
        ["install-tools", "prepare-home", "prepare-github-provider"],
      );
    })));

  it.effect("adds only the approved Fleet AI Gateway client boundary", () =>
    withPlatform(Effect.gen(function*() {
      const workload = yield* render(
        join(runtime, "tests", "fixtures", "ai-gateway-client"),
      ).pipe(Effect.flatMap(statefulSet));
      const spec = workload.spec;
      const pod = spec.template.spec;
      const firstMate = yield* required(
        pod.containers.find(({ name }) => name === "agentos"),
        "Missing First Mate container",
      );
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const variables = environment(
        yield* required(firstMate.env, "Missing First Mate environment"),
      );
      const prepareVariables = environment(
        yield* required(prepare.env, "Missing prepare environment"),
      );
      assert.deepStrictEqual(pod.initContainers.map(({ name }) => name), [
        "install-tools",
        "prepare-home",
        "prepare-github-provider",
      ]);
      assert.deepInclude(spec.template.metadata.labels, {
        "agentos.akua.dev/agentgateway-client": "true",
      });
      assert.strictEqual(
        variables.AI_GATEWAY_URL,
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      );
      assert.isUndefined(variables.AI_GATEWAY_TOKEN);
      assert.strictEqual(
        variables.AGENTOS_EGRESS_TOKEN_FILE,
        "/var/run/secrets/agentos-egress/token",
      );
      assert.strictEqual(variables.AGENTOS_PI_PROVIDER_MODE, "ai-gateway");
      assert.strictEqual(variables.AGENTOS_PROVIDER_CREDENTIAL_KIND, "ai_gateway");
      assert.deepInclude(prepareVariables, {
        AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
        AI_GATEWAY_URL:
          "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      });
      assert.isUndefined(prepareVariables.AI_GATEWAY_TOKEN);
      assert.isUndefined(variables.AGENTOS_MODEL);
      assert.isUndefined(variables.AGENTOS_THINKING);
      assert.isUndefined(prepareVariables.AGENTOS_MODEL);
      assert.isUndefined(prepareVariables.AGENTOS_THINKING);
      assert.strictEqual(pod.serviceAccountName, "agentos-firstmate");
      assert.strictEqual(spec.volumeClaimTemplates[0]?.metadata.name, "home");
    })));

  it.effect("renders an explicit one-rollout return to direct Pi auth", () =>
    withPlatform(Effect.gen(function*() {
      const workload = yield* render(
        join(runtime, "tests", "fixtures", "ai-gateway-direct-auth"),
      ).pipe(Effect.flatMap(statefulSet));
      const pod = workload.spec.template.spec;
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const runtimeContainer = yield* required(
        pod.containers.find(({ name }) => name === "agentos"),
        "Missing First Mate container",
      );
      const prepareVariables = environment(
        yield* required(prepare.env, "Missing prepare environment"),
      );
      const runtimeVariables = environment(
        yield* required(runtimeContainer.env, "Missing runtime environment"),
      );
      assert.deepStrictEqual(pod.initContainers.map(({ name }) => name), [
        "install-tools",
        "prepare-home",
        "prepare-github-provider",
      ]);
      assert.strictEqual(prepareVariables.AGENTOS_PI_PROVIDER_MODE, "direct");
      assert.isUndefined(prepareVariables.AI_GATEWAY_URL);
      assert.isUndefined(prepareVariables.AI_GATEWAY_TOKEN);
      assert.isUndefined(prepareVariables.AGENTOS_MODEL);
      assert.isUndefined(runtimeVariables.AGENTOS_PI_PROVIDER_MODE);
      assert.isUndefined(runtimeVariables.AI_GATEWAY_URL);
      assert.isUndefined(runtimeVariables.AI_GATEWAY_TOKEN);
      assert.notProperty(
        workload.spec.template.metadata.labels,
        "agentos.akua.dev/agentgateway-client",
      );
    })));
});
