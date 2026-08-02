import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../../../../src/access/identity.ts";
import { renderKustomize } from "../../../../../../../tooling/testing/kubernetes.ts";

const EnvironmentEntry = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  valueFrom: Schema.optional(Schema.Unknown),
});
type EnvironmentEntry = typeof EnvironmentEntry.Type;
const ExecProbe = Schema.Struct({
  exec: Schema.Struct({ command: Schema.Array(Schema.String) }),
});
const Container = Schema.Struct({
  name: Schema.String,
  image: Schema.optional(Schema.String),
  resources: Schema.optional(Schema.Unknown),
  workingDir: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvironmentEntry)),
  livenessProbe: Schema.optional(ExecProbe),
  readinessProbe: Schema.optional(ExecProbe),
  securityContext: Schema.optional(Schema.Unknown),
  volumeMounts: Schema.optional(Schema.Unknown),
});
const Metadata = Schema.Struct({
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Resource = Schema.Struct({
  automountServiceAccountToken: Schema.optional(Schema.Boolean),
  kind: Schema.String,
  metadata: Metadata,
  spec: Schema.optional(Schema.Unknown),
});
type Resource = typeof Resource.Type;
const Resources = Schema.Array(Resource);
const StatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Metadata,
  spec: Schema.Struct({
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
        automountServiceAccountToken: Schema.Boolean,
        securityContext: Schema.Unknown,
        initContainers: Schema.Array(Container),
        containers: Schema.Array(Container),
        volumes: Schema.Unknown,
      }),
    }),
  }),
});

export class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.crewmateManifest.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const resource = Effect.fn("test.crewmateManifest.resource")(function*(
  resources: ReadonlyArray<Resource>,
  kind: string,
) {
  return yield* required(
    resources.find((candidate) => candidate.kind === kind),
    `Missing ${kind}`,
  );
});

function environment(entries: ReadonlyArray<EnvironmentEntry>) {
  return Object.fromEntries(
    entries.map(({ name, value, valueFrom }) => [name, value ?? valueFrom]),
  );
}

const kubernetes = fileURLToPath(new URL("..", import.meta.url));
const render = Effect.fn("test.crewmateManifest.render")(function*(
  directory = join(kubernetes, "base"),
) {
  const documents = yield* renderKustomize(directory, {
    loadRestrictionsNone: true,
  });
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});

describe("Crewmate Kubernetes base", () => {
  it.effect("renders one independently attachable Herdr runtime", () =>
    Effect.gen(function*() {
      const resources = yield* render();
      assert.deepStrictEqual(resources.map(({ kind }) => kind).sort(), [
        "Service",
        "ServiceAccount",
        "StatefulSet",
      ]);
      assert.isTrue(
        resources.every(({ metadata }) => metadata.namespace === undefined),
      );

      const rawStatefulSet = yield* resource(resources, "StatefulSet");
      const statefulSet = yield* Schema.decodeUnknownEffect(StatefulSet)(
        rawStatefulSet,
      );
      assert.strictEqual(statefulSet.metadata.name, "agentos-crewmate");
      assert.strictEqual(statefulSet.spec.serviceName, "agentos-crewmate");
      assert.deepStrictEqual(
        statefulSet.spec.persistentVolumeClaimRetentionPolicy,
        { whenDeleted: "Retain", whenScaled: "Retain" },
      );
      assert.deepStrictEqual(statefulSet.spec.volumeClaimTemplates, [{
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      }]);

      const pod = statefulSet.spec.template.spec;
      assert.deepStrictEqual(statefulSet.spec.template.metadata, {
        annotations: {
          "agentos.akua.dev/container": "crewmate",
          "agentos.akua.dev/herdr-session": "agentos-crewmate",
        },
        labels: {
          "agentos.akua.dev/agent": "crewmate",
          "agentos.akua.dev/agent-id":
            "00000000-0000-4000-8000-000000000003",
          "agentos.akua.dev/assignment-id":
            "00000000-0000-4000-8000-000000000005",
          "agentos.akua.dev/github-client": "true",
          "agentos.akua.dev/otel-client": "true",
          "agentos.akua.dev/owner-agent-id":
            "00000000-0000-4000-8000-000000000002",
          "agentos.akua.dev/task-id":
            "00000000-0000-4000-8000-000000000004",
          "app.kubernetes.io/name": "agentos-crewmate",
          "app.kubernetes.io/part-of": "agentos",
        },
      });
      const serviceAccount = yield* resource(resources, "ServiceAccount");
      assert.isFalse(serviceAccount.automountServiceAccountToken);
      assert.strictEqual(pod.serviceAccountName, "agentos-crewmate");
      assert.isFalse(pod.automountServiceAccountToken);
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
      const container = yield* required(pod.containers[0], "Missing Crewmate");
      assert.deepStrictEqual(
        [...pod.initContainers, container].map(({ image }) => image),
        ["agentos:dev", "agentos:dev", "agentos:dev", "agentos:dev"],
      );
      assert.deepStrictEqual(
        [...pod.initContainers, container].map(({ resources }) => resources),
        [
          {
            limits: { cpu: "2", memory: "2Gi" },
            requests: { cpu: "250m", memory: "512Mi" },
          },
          {
            limits: { cpu: "2", memory: "2Gi" },
            requests: { cpu: "250m", memory: "512Mi" },
          },
          {
            limits: { cpu: "250m", memory: "128Mi" },
            requests: { cpu: "25m", memory: "32Mi" },
          },
          {
            limits: { cpu: "2", memory: "4Gi" },
            requests: { cpu: "250m", memory: "512Mi" },
          },
        ],
      );
      assert.deepStrictEqual(
        [...pod.initContainers, container].map(({ workingDir }) => workingDir),
        [
          "/opt/agentos/packages/agentos/resources/crewmates/default",
          "/opt/agentos/packages/agentos/resources/crewmates/default",
          undefined,
          "/opt/agentos/packages/agentos/resources/crewmates/default",
        ],
      );
      assert.deepStrictEqual(install.command, ["mise"]);
      assert.deepStrictEqual(install.args, [
        "install",
        "--locked",
        "node",
        "gh",
        "kubectl",
        "github:ogulcancelik/herdr",
        "github:kunchenguid/no-mistakes",
        "github:kunchenguid/treehouse",
        "npm:@openai/codex",
        "npm:gh-axi",
      ]);
      assert.deepStrictEqual(prepare.command, ["mise"]);
      assert.deepStrictEqual(prepare.args, [
        "run",
        "--skip-tools",
        "crewmate:prepare",
      ]);
      const variables = environment(
        yield* required(container.env, "Missing Crewmate environment"),
      );
      assert.deepInclude(variables, {
        AGENTOS_AGENT_CWD:
          "/opt/agentos/packages/agentos/resources/crewmates/default",
        AGENTOS_DISTRIBUTION_ROOT: "/opt/agentos/packages/agentos",
        AGENTOS_AGENT_ID: "00000000-0000-4000-8000-000000000003",
        AGENTOS_AGENT_NAME: "crewmate",
        AGENTOS_AGENT_ROLE: "crewmate",
        AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
        AGENTOS_BRIEF_PATH: "/home/agent/brief.md",
        AGENTOS_BRIEF_SHA256: "0".repeat(64),
        AGENTOS_DATABASE_IDENTITY: "runtime_crewmate",
        AGENTOS_DATABASE_URL:
          "postgresql://runtime_crewmate@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
        AGENTOS_HARNESS: "codex",
        AGENTOS_PGPASS_SOURCE: "/var/run/secrets/agentos/pgpass",
        AGENTOS_PROVIDER_CREDENTIAL_KIND: "codex_auth",
        AGENTOS_TASK_ID: "00000000-0000-4000-8000-000000000004",
        HERDR_SESSION: "agentos-crewmate",
        PGPASSFILE: "/home/agent/.pgpass",
      });
      assert.isUndefined(variables.AGENTOS_MODEL);
      assert.isUndefined(variables.AGENTOS_THINKING);
      assert.strictEqual(
        variables.OTEL_EXPORTER_OTLP_ENDPOINT,
        "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
      );
      assert.isUndefined(variables.PI_CODING_AGENT_DIR);
      assert.deepStrictEqual(container.command, ["herdr"]);
      assert.deepStrictEqual(container.args, [
        "server",
        "--session",
        "agentos-crewmate",
      ]);
      assert.deepStrictEqual(container.livenessProbe, {
        exec: { command: [
          "mise",
          "run",
          "--skip-tools",
          "crewmate:health",
          "--",
          "live",
        ] },
      });
      assert.deepStrictEqual(container.readinessProbe, {
        exec: { command: [
          "mise",
          "run",
          "--skip-tools",
          "crewmate:health",
          "--",
          "ready",
        ] },
      });
      assert.deepStrictEqual(container.securityContext, {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
      });
      assert.deepStrictEqual(container.volumeMounts, [
        { mountPath: "/home/agent", name: "home" },
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
      assert.deepStrictEqual(prepare.volumeMounts, [
        { mountPath: "/home/agent", name: "home" },
        {
          mountPath: "/var/run/secrets/agentos",
          name: "database-credentials",
          readOnly: true,
        },
      ]);
      assert.deepStrictEqual(pod.volumes, [
        {
          name: "database-credentials",
          secret: { defaultMode: 288, secretName: "agentos-crewmate-postgres" },
        },
        {
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
        },
        {
          name: "agentos-github-ca",
          configMap: {
            defaultMode: 292,
            items: [{ key: "ca.pem", path: "ca.pem" }],
            name: "agentos-github-ca",
          },
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("adds only the approved Fleet AI Gateway client boundary", () =>
    Effect.gen(function*() {
      const resources = yield* render(
        join(kubernetes, "tests", "fixtures", "ai-gateway-client"),
      );
      const statefulSet = yield* Schema.decodeUnknownEffect(StatefulSet)(
        yield* resource(resources, "StatefulSet"),
      );
      const pod = statefulSet.spec.template.spec;
      const container = yield* required(
        pod.containers.find(({ name }) => name === "crewmate"),
        "Missing Crewmate container",
      );
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const variables = environment(
        yield* required(container.env, "Missing Crewmate environment"),
      );
      const prepareVariables = environment(
        yield* required(prepare.env, "Missing prepare environment"),
      );

      assert.deepInclude(statefulSet.spec.template.metadata.labels, {
        "agentos.akua.dev/agentgateway-client": "true",
      });
      assert.strictEqual(
        variables.AI_GATEWAY_URL,
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      );
      assert.isUndefined(variables.AI_GATEWAY_TOKEN);
      assert.strictEqual(variables.AGENTOS_CODEX_PROVIDER_MODE, "ai-gateway");
      assert.strictEqual(
        variables.AGENTOS_EGRESS_TOKEN_FILE,
        "/var/run/secrets/agentos-egress/token",
      );
      assert.deepInclude(prepareVariables, {
        AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
        AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
        AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
        AI_GATEWAY_URL:
          "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      });
      assert.strictEqual(
        variables.AGENTOS_PROVIDER_CREDENTIAL_KIND,
        "ai_gateway",
      );
      assert.strictEqual(pod.serviceAccountName, "agentos-crewmate");
      assert.strictEqual(statefulSet.spec.volumeClaimTemplates[0]?.metadata.name, "home");
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("renders an explicit one-rollout return to direct Codex auth", () =>
    Effect.gen(function*() {
      const resources = yield* render(
        join(kubernetes, "tests", "fixtures", "ai-gateway-direct-auth"),
      );
      const statefulSet = yield* Schema.decodeUnknownEffect(StatefulSet)(
        yield* resource(resources, "StatefulSet"),
      );
      const pod = statefulSet.spec.template.spec;
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const container = yield* required(
        pod.containers.find(({ name }) => name === "crewmate"),
        "Missing Crewmate container",
      );
      const prepareVariables = environment(
        yield* required(prepare.env, "Missing prepare environment"),
      );
      const variables = environment(
        yield* required(container.env, "Missing Crewmate environment"),
      );

      assert.strictEqual(prepareVariables.AGENTOS_CODEX_PROVIDER_MODE, "direct");
      assert.strictEqual(
        prepareVariables.AGENTOS_ASSIGNMENT_ID,
        "00000000-0000-4000-8000-000000000005",
      );
      assert.isUndefined(prepareVariables.AI_GATEWAY_URL);
      assert.isUndefined(variables.AGENTOS_CODEX_PROVIDER_MODE);
      assert.strictEqual(
        variables.AGENTOS_ASSIGNMENT_ID,
        "00000000-0000-4000-8000-000000000005",
      );
      assert.isUndefined(variables.AI_GATEWAY_URL);
      assert.notProperty(
        statefulSet.spec.template.metadata.labels,
        "agentos.akua.dev/agentgateway-client",
      );
    }).pipe(Effect.provide(BunServices.layer)));
});
