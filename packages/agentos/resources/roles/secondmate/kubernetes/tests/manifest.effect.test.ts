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
const VolumeMount = Schema.Struct({
  mountPath: Schema.String,
  name: Schema.String,
  readOnly: Schema.optional(Schema.Boolean),
});
const Container = Schema.Struct({
  name: Schema.String,
  image: Schema.String,
  workingDir: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvironmentEntry)),
  resources: Schema.optional(Schema.Struct({
    limits: Schema.Record(Schema.String, Schema.String),
    requests: Schema.Record(Schema.String, Schema.String),
  })),
  volumeMounts: Schema.optional(Schema.Array(VolumeMount)),
});
const Metadata = Schema.Struct({
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
});
const Rule = Schema.Struct({
  apiGroups: Schema.Array(Schema.String),
  resources: Schema.Array(Schema.String),
  verbs: Schema.Array(Schema.String),
});
const RoleReference = Schema.Struct({
  apiGroup: Schema.String,
  kind: Schema.String,
  name: Schema.String,
});
const Subject = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  namespace: Schema.optional(Schema.String),
});
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Metadata,
  roleRef: Schema.optional(RoleReference),
  rules: Schema.optional(Schema.Array(Rule)),
  spec: Schema.optional(Schema.Unknown),
  subjects: Schema.optional(Schema.Array(Subject)),
});
type Resource = typeof Resource.Type;
const Resources = Schema.Array(Resource);
const StatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Metadata,
  spec: Schema.Struct({
    persistentVolumeClaimRetentionPolicy: Schema.Unknown,
    volumeClaimTemplates: Schema.Array(Schema.Struct({
      metadata: Schema.Struct({ name: Schema.String }),
    })),
    template: Schema.Struct({
      metadata: Schema.Struct({
        labels: Schema.Record(Schema.String, Schema.String),
      }),
      spec: Schema.Struct({
        serviceAccountName: Schema.String,
        automountServiceAccountToken: Schema.Boolean,
        securityContext: Schema.Unknown,
        volumes: Schema.Unknown,
        initContainers: Schema.Array(Container),
        containers: Schema.Array(Container),
      }),
    }),
  }),
});
const AdmissionPolicy = Schema.Struct({
  kind: Schema.Literal("ValidatingAdmissionPolicy"),
  metadata: Metadata,
  spec: Schema.Struct({
    failurePolicy: Schema.String,
    validations: Schema.Array(Schema.Unknown),
  }),
});

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.secondMateManifest.required")(function*<A>(
  value: A | undefined,
  detail: string,
) {
  if (value === undefined) return yield* ManifestFixtureError.make({ detail });
  return value;
});

const namedResource = Effect.fn("test.secondMateManifest.namedResource")(
  function*(resources: ReadonlyArray<Resource>, kind: string, name: string) {
    return yield* required(
      resources.find((candidate) =>
        candidate.kind === kind && candidate.metadata.name === name
      ),
      `Missing ${kind}/${name}`,
    );
  },
);

const resource = Effect.fn("test.secondMateManifest.resource")(function*(
  resources: ReadonlyArray<Resource>,
  kind: string,
) {
  return yield* required(
    resources.find((candidate) => candidate.kind === kind),
    `Missing ${kind}`,
  );
});

const statefulSet = Effect.fn("test.secondMateManifest.statefulSet")(
  (resources: ReadonlyArray<Resource>) =>
    resource(resources, "StatefulSet").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StatefulSet)),
    ),
);

function environment(entries: ReadonlyArray<EnvironmentEntry>) {
  return Object.fromEntries(
    entries.map(({ name, value, valueFrom }) => [name, value ?? valueFrom]),
  );
}

const kubernetes = fileURLToPath(new URL("..", import.meta.url));
const render = Effect.fn("test.secondMateManifest.render")(function*(
  directory = join(kubernetes, "base"),
) {
  const documents = yield* renderKustomize(directory, {
    loadRestrictionsNone: true,
  });
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(BunServices.layer));

describe("Second Mate Kubernetes base", () => {
  it.effect("renders one persistent isolated Pi Mate", () =>
    withPlatform(Effect.gen(function*() {
      const resources = yield* render();
      assert.deepStrictEqual(resources.map(({ kind }) => kind).sort(), [
        "Service",
        "ServiceAccount",
        "StatefulSet",
      ]);
      assert.isTrue(
        resources.every(({ metadata }) => metadata.namespace === undefined),
      );

      const workload = yield* statefulSet(resources);
      assert.strictEqual(workload.metadata.name, "agentos-secondmate");
      assert.deepStrictEqual(
        workload.spec.persistentVolumeClaimRetentionPolicy,
        { whenDeleted: "Retain", whenScaled: "Retain" },
      );
      const pod = workload.spec.template.spec;
      assert.strictEqual(pod.serviceAccountName, "agentos-secondmate");
      assert.isTrue(pod.automountServiceAccountToken);
      assert.deepStrictEqual(pod.securityContext, {
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        runAsGroup: 1000,
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.deepStrictEqual(pod.volumes, [
        {
          name: "database-credentials",
          secret: {
            defaultMode: 288,
            secretName: "agentos-secondmate-postgres",
          },
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
      assert.lengthOf(pod.initContainers, 3);
      assert.lengthOf(pod.containers, 1);
      const container = yield* required(
        pod.containers[0],
        "Missing Second Mate container",
      );
      const allContainers = [...pod.initContainers, container];
      assert.deepStrictEqual(allContainers.map(({ image }) => image), [
        "agentos:dev",
        "agentos:dev",
        "agentos:dev",
        "agentos:dev",
      ]);
      const githubProvider = yield* required(
        pod.initContainers.find(({ name }) =>
          name === "prepare-github-provider"
        ),
        "Missing GitHub provider preparation container",
      );
      assert.deepStrictEqual(githubProvider.resources, {
        limits: { cpu: "250m", memory: "128Mi" },
        requests: { cpu: "25m", memory: "64Mi" },
      });
      assert.deepStrictEqual(
        allContainers.map(({ workingDir }) => workingDir),
        [
          "/opt/agentos/packages/agentos/resources/roles/secondmate",
          "/opt/agentos/packages/agentos/resources/roles/secondmate",
          undefined,
          "/opt/agentos/packages/agentos/resources/roles/secondmate",
        ],
      );
      const variables = environment(
        yield* required(container.env, "Missing Second Mate environment"),
      );
      assert.strictEqual(
        variables.AGENTOS_AGENT_CWD,
        "/home/agent/projects/agentos/packages/agentos/resources/roles/secondmate",
      );
      assert.strictEqual(
        variables.AGENTOS_DISTRIBUTION_ROOT,
        "/home/agent/projects/agentos/packages/agentos",
      );
      assert.strictEqual(variables.AGENTOS_AGENT_ROLE, "second_mate");
      assert.strictEqual(variables.AGENTOS_DATABASE_IDENTITY, "runtime_secondmate");
      assert.strictEqual(variables.AGENTOS_PROVIDER_CREDENTIAL_KIND, "pi_auth");
      assert.include(
        variables.AGENTOS_DATABASE_URL,
        "@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos",
      );
      assert.strictEqual(
        variables.OTEL_EXPORTER_OTLP_ENDPOINT,
        "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
      );
      assert.isUndefined(variables.AGENTOS_MODEL);
      assert.isUndefined(variables.AGENTOS_THINKING);
      assert.deepInclude(container.volumeMounts ?? [], {
        mountPath: "/var/run/secrets/agentos-egress",
        name: "agentos-egress-identity",
        readOnly: true,
      });
      for (const initContainer of pod.initContainers) {
        assert.isFalse(
          (initContainer.volumeMounts ?? []).some(({ name }) =>
            name === "agentos-egress-identity"
          ),
        );
      }
      assert.deepStrictEqual(container.args, [
        "run",
        "--skip-tools",
        "secondmate:run",
      ]);
    })));

  it.effect("adds only the approved Fleet AI Gateway client boundary", () =>
    withPlatform(Effect.gen(function*() {
      const workload = yield* render(
        join(kubernetes, "tests", "fixtures", "ai-gateway-client"),
      ).pipe(Effect.flatMap(statefulSet));
      const spec = workload.spec;
      const pod = spec.template.spec;
      const container = yield* required(
        pod.containers.find(({ name }) => name === "agentos"),
        "Missing Second Mate container",
      );
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const variables = environment(
        yield* required(container.env, "Missing Second Mate environment"),
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
      assert.strictEqual(pod.serviceAccountName, "agentos-secondmate");
      assert.strictEqual(spec.volumeClaimTemplates[0]?.metadata.name, "home");
    })));

  it.effect("renders an explicit one-rollout return to direct Pi auth", () =>
    withPlatform(Effect.gen(function*() {
      const workload = yield* render(
        join(kubernetes, "tests", "fixtures", "ai-gateway-direct-auth"),
      ).pipe(Effect.flatMap(statefulSet));
      const pod = workload.spec.template.spec;
      const prepare = yield* required(
        pod.initContainers.find(({ name }) => name === "prepare-home"),
        "Missing prepare-home container",
      );
      const runtimeContainer = yield* required(
        pod.containers.find(({ name }) => name === "agentos"),
        "Missing Second Mate container",
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

  it.effect("renders the same persistent Mate base into isolated domain namespaces", () =>
    withPlatform(Effect.gen(function*() {
      const fixtures = [
        {
          directory: "domain-alpha",
          namespace: "agentos-domain-alpha",
          ownerAgentId: "00000000-0000-4000-8000-00000000000a",
        },
        {
          directory: "domain-beta",
          namespace: "agentos-domain-beta",
          ownerAgentId: "00000000-0000-4000-8000-00000000000b",
        },
      ];
      const rendered = yield* Effect.forEach(fixtures, (fixture) =>
        render(join(kubernetes, "tests", "fixtures", fixture.directory)).pipe(
          Effect.map((resources) => ({ ...fixture, resources })),
        ), { concurrency: "unbounded" });

      for (const fixture of rendered) {
        assert.deepStrictEqual(
          fixture.resources
            .map(({ kind, metadata }) => `${kind}/${metadata.name}`)
            .sort(),
          [
            "LimitRange/agentos-domain-workload-limits",
            `Namespace/${fixture.namespace}`,
            "NetworkPolicy/agentos-domain-ingress",
            "ResourceQuota/agentos-domain-capacity",
            "Role/agentos-firstmate-domain-supervisor",
            "Role/agentos-secondmate-workload-manager",
            "RoleBinding/agentos-firstmate-domain-supervisor-binding",
            "RoleBinding/agentos-secondmate-workload-manager-binding",
            "Service/agentos-secondmate",
            "ServiceAccount/agentos-secondmate",
            "StatefulSet/agentos-secondmate",
          ],
        );
        assert.isTrue(
          fixture.resources
            .filter(({ kind }) => kind !== "Namespace")
            .every(({ metadata }) => metadata.namespace === fixture.namespace),
        );
        const namespace = yield* namedResource(
          fixture.resources,
          "Namespace",
          fixture.namespace,
        );
        assert.deepStrictEqual(namespace.metadata.labels, {
          "agentos.akua.dev/crewmate-admission": "v1",
          "agentos.akua.dev/fleet": "default",
          "agentos.akua.dev/managed-by": "agentos-firstmate",
          "agentos.akua.dev/owner-agent-id": fixture.ownerAgentId,
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/audit-version": "v1.35",
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "v1.35",
          "pod-security.kubernetes.io/warn": "restricted",
          "pod-security.kubernetes.io/warn-version": "v1.35",
        });
        const workload = yield* statefulSet(fixture.resources);
        const container = yield* required(
          workload.spec.template.spec.containers[0],
          "Missing Second Mate container",
        );
        assert.strictEqual(
          environment(yield* required(container.env, "Missing environment"))
            .AGENTOS_AGENT_ID,
          fixture.ownerAgentId,
        );
      }

      const workloadIdentities = yield* Effect.forEach(
        rendered,
        (fixture) => statefulSet(fixture.resources).pipe(
          Effect.map((workload) =>
            `${fixture.namespace}/${workload.kind}/${workload.metadata.name}`
          ),
        ),
      );
      assert.strictEqual(new Set(workloadIdentities).size, 2);
    })));

  it.effect("grants child lifecycle authority without domain-control authority", () =>
    withPlatform(Effect.gen(function*() {
      const namespace = "agentos-domain-alpha";
      const resources = yield* render(
        join(kubernetes, "tests", "fixtures", "domain-alpha"),
      );
      const workloadRole = yield* namedResource(
        resources,
        "Role",
        "agentos-secondmate-workload-manager",
      );
      assert.deepStrictEqual(workloadRole.rules, [
        {
          apiGroups: [""],
          resources: ["pods"],
          verbs: ["delete", "get", "list", "watch"],
        },
        { apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] },
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
        {
          apiGroups: [""],
          resources: ["events", "persistentvolumeclaims"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: [""],
          resources: ["serviceaccounts", "services"],
          verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
        },
        {
          apiGroups: ["apps"],
          resources: ["statefulsets"],
          verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
        },
      ]);
      const forbidden = /secret|role|networkpolic|resourcequota|limitrange|namespace|^\*$/i;
      assert.isFalse(
        (workloadRole.rules ?? []).flatMap((rule) => [
          ...rule.apiGroups,
          ...rule.resources,
          ...rule.verbs,
        ]).some((value) => forbidden.test(value)),
      );

      const workloadBinding = yield* namedResource(
        resources,
        "RoleBinding",
        "agentos-secondmate-workload-manager-binding",
      );
      assert.deepStrictEqual({
        roleRef: workloadBinding.roleRef,
        subjects: workloadBinding.subjects,
      }, {
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: "agentos-secondmate-workload-manager",
        },
        subjects: [{
          kind: "ServiceAccount",
          name: "agentos-secondmate",
          namespace,
        }],
      });

      const firstMateRole = yield* namedResource(
        resources,
        "Role",
        "agentos-firstmate-domain-supervisor",
      );
      const firstMateRules = firstMateRole.rules ?? [];
      assert.isFalse(
        firstMateRules.some((rule) =>
          [...rule.apiGroups, ...rule.resources, ...rule.verbs].includes("*")
        ),
      );
      assert.isTrue(firstMateRules.some((rule) =>
        rule.resources.length === 1 && rule.resources[0] === "pods/exec" &&
        rule.verbs.length === 1 && rule.verbs[0] === "create"
      ));
      assert.isTrue(firstMateRules.some((rule) =>
        rule.resources.includes("secrets") &&
        rule.verbs.join(",") === "create,delete,get,list,patch,update,watch"
      ));
      assert.isTrue(firstMateRules.some((rule) =>
        rule.apiGroups.length === 1 &&
        rule.apiGroups[0] === "rbac.authorization.k8s.io" &&
        rule.resources.includes("rolebindings") && rule.resources.includes("roles")
      ));
      const firstMateBinding = yield* namedResource(
        resources,
        "RoleBinding",
        "agentos-firstmate-domain-supervisor-binding",
      );
      assert.deepStrictEqual(firstMateBinding.subjects, [{
        kind: "ServiceAccount",
        name: "agentos-firstmate",
        namespace: "agentos",
      }]);

      assert.deepStrictEqual(
        (yield* namedResource(
          resources,
          "ResourceQuota",
          "agentos-domain-capacity",
        )).spec,
        {
          hard: {
            "count/persistentvolumeclaims": "16",
            "count/pods": "16",
            "count/services": "16",
            "count/services.loadbalancers": "0",
            "count/services.nodeports": "0",
            "count/statefulsets.apps": "16",
            "limits.cpu": "32",
            "limits.memory": "64Gi",
            "requests.cpu": "16",
            "requests.memory": "32Gi",
            "requests.storage": "320Gi",
          },
        },
      );
      assert.deepStrictEqual(
        (yield* namedResource(
          resources,
          "LimitRange",
          "agentos-domain-workload-limits",
        )).spec,
        {
          limits: [
            {
              default: { cpu: "2", memory: "4Gi" },
              defaultRequest: { cpu: "250m", memory: "512Mi" },
              max: { cpu: "4", memory: "8Gi" },
              min: { cpu: "25m", memory: "64Mi" },
              type: "Container",
            },
            {
              max: { storage: "40Gi" },
              min: { storage: "1Gi" },
              type: "PersistentVolumeClaim",
            },
          ],
        },
      );
      assert.deepStrictEqual(resources.filter(({ kind }) => kind === "Secret"), []);
      assert.deepStrictEqual(
        (yield* namedResource(
          resources,
          "NetworkPolicy",
          "agentos-domain-ingress",
        )).spec,
        {
          ingress: [{ from: [{ podSelector: {} }] }],
          podSelector: {},
          policyTypes: ["Ingress"],
        },
      );
    })));

  it.effect("renders cluster admission selected only by managed domain labels", () =>
    withPlatform(Effect.gen(function*() {
      const resources = yield* render(join(kubernetes, "admission"));
      assert.deepStrictEqual(
        resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
        [
          "ValidatingAdmissionPolicy/agentos-crewmate-pods",
          "ValidatingAdmissionPolicy/agentos-crewmate-statefulsets",
          "ValidatingAdmissionPolicyBinding/agentos-crewmate-pods",
          "ValidatingAdmissionPolicyBinding/agentos-crewmate-statefulsets",
        ],
      );
      assert.isTrue(
        resources.every(({ metadata }) => metadata.namespace === undefined),
      );
      for (const policyName of [
        "agentos-crewmate-statefulsets",
        "agentos-crewmate-pods",
      ]) {
        const policy = yield* namedResource(
          resources,
          "ValidatingAdmissionPolicy",
          policyName,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AdmissionPolicy)));
        assert.strictEqual(policy.spec.failurePolicy, "Fail");
        assert.isAbove(policy.spec.validations.length, 0);
        const binding = yield* namedResource(
          resources,
          "ValidatingAdmissionPolicyBinding",
          policyName,
        );
        assert.deepStrictEqual(binding.spec, {
          matchResources: {
            namespaceSelector: {
              matchLabels: { "agentos.akua.dev/crewmate-admission": "v1" },
            },
          },
          policyName,
          validationActions: ["Deny", "Audit"],
        });
      }
    })));
});
