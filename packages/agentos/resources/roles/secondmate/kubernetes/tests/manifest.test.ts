import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: {
    labels?: Record<string, string>;
    name: string;
    namespace?: string;
  };
  roleRef?: Record<string, string>;
  rules?: Array<Record<string, string[]>>;
  spec?: Record<string, any>;
  subjects?: Array<Record<string, string>>;
};

const kubernetes = new URL("..", import.meta.url).pathname;

async function render(
  directory = join(kubernetes, "base"),
): Promise<Resource[]> {
  const process = Bun.spawn(
    [
      "kubectl",
      "kustomize",
      "--load-restrictor",
      "LoadRestrictionsNone",
      directory,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return Bun.YAML.parse(stdout) as Resource[];
}

function resource(resources: Resource[], kind: string) {
  const match = resources.find((candidate) => candidate.kind === kind);
  if (!match) throw new Error(`Missing ${kind}`);
  return match;
}

function namedResource(resources: Resource[], kind: string, name: string) {
  const match = resources.find(
    (candidate) =>
      candidate.kind === kind && candidate.metadata.name === name,
  );
  if (!match) throw new Error(`Missing ${kind}/${name}`);
  return match;
}

describe("Second Mate Kubernetes base", () => {
  test("renders one persistent isolated Pi Mate", async () => {
    const resources = await render();
    expect(resources.map(({ kind }) => kind).sort()).toEqual([
      "Service",
      "ServiceAccount",
      "StatefulSet",
    ]);
    expect(
      resources.every(({ metadata }) => metadata.namespace === undefined),
    ).toBe(true);

    const statefulSet = resource(resources, "StatefulSet");
    expect(statefulSet.metadata.name).toBe("agentos-secondmate");
    expect(statefulSet.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    const pod = statefulSet.spec?.template.spec;
    expect(pod.serviceAccountName).toBe("agentos-secondmate");
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.volumes).toEqual([
      {
        name: "database-credentials",
        secret: {
          defaultMode: 288,
          secretName: "agentos-secondmate-postgres",
        },
      },
    ]);
    expect(pod.initContainers).toHaveLength(2);
    expect(pod.containers).toHaveLength(1);
    const container = pod.containers[0];
    const allContainers = [...pod.initContainers, container];
    expect(allContainers.map(({ image }: { image: string }) => image)).toEqual([
      "agentos:dev",
      "agentos:dev",
      "agentos:dev",
    ]);
    expect(
      allContainers.map(({ workingDir }: { workingDir: string }) => workingDir),
    ).toEqual([
      "/opt/agentos/packages/agentos/resources/roles/secondmate",
      "/opt/agentos/packages/agentos/resources/roles/secondmate",
      "/opt/agentos/packages/agentos/resources/roles/secondmate",
    ]);
    const environment = Object.fromEntries(
      container.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(environment.AGENTOS_AGENT_CWD).toBe(
      "/home/agent/projects/agentos/packages/agentos/resources/roles/secondmate",
    );
    expect(environment.AGENTOS_DISTRIBUTION_ROOT).toBe(
      "/home/agent/projects/agentos/packages/agentos",
    );
    expect(environment.AGENTOS_AGENT_ROLE).toBe("second_mate");
    expect(environment.AGENTOS_DATABASE_URL).toContain(
      "@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos",
    );
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
    );
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(container.args).toEqual(["run", "--skip-tools", "secondmate:run"]);
  });

  test("adds only the approved Fleet AI Gateway client boundary", async () => {
    const resources = await render(
      join(kubernetes, "tests", "fixtures", "ai-gateway-client"),
    );
    const statefulSet = resource(resources, "StatefulSet");
    const spec = statefulSet.spec!;
    const pod = spec.template.spec;
    const container = pod.containers.find(
      ({ name }: { name: string }) => name === "agentos",
    );
    const prepare = pod.initContainers.find(
      ({ name }: { name: string }) => name === "prepare-home",
    );
    const environment = Object.fromEntries(
      container.env.map(
        ({ name, value, valueFrom }: Record<string, unknown>) => [
          name,
          value ?? valueFrom,
        ],
      ),
    );
    const prepareEnvironment = Object.fromEntries(
      prepare.env.map(
        ({ name, value, valueFrom }: Record<string, unknown>) => [
          name,
          value ?? valueFrom,
        ],
      ),
    );

    expect(spec.template.metadata.labels).toMatchObject({
      "agentos.akua.dev/ai-gateway-client": "true",
    });
    expect(environment.AI_GATEWAY_URL).toBe(
      "http://ai-gateway.agentos.svc.cluster.local:8787",
    );
    expect(environment.AI_GATEWAY_TOKEN).toEqual({
      secretKeyRef: { key: "token", name: "ai-gateway-client" },
    });
    expect(environment.AGENTOS_PI_PROVIDER_MODE).toBe("ai-gateway");
    expect(prepareEnvironment).toMatchObject({
      AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
      AI_GATEWAY_TOKEN: {
        secretKeyRef: { key: "token", name: "ai-gateway-client" },
      },
      AI_GATEWAY_URL:
        "http://ai-gateway.agentos.svc.cluster.local:8787",
    });
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(prepareEnvironment.AGENTOS_MODEL).toBeUndefined();
    expect(prepareEnvironment.AGENTOS_THINKING).toBeUndefined();
    expect(pod.serviceAccountName).toBe("agentos-secondmate");
    expect(spec.volumeClaimTemplates[0].metadata.name).toBe("home");
  });

  test("renders an explicit one-rollout return to direct Pi auth", async () => {
    const resources = await render(
      join(kubernetes, "tests", "fixtures", "ai-gateway-direct-auth"),
    );
    const statefulSet = resource(resources, "StatefulSet");
    const pod = statefulSet.spec!.template.spec;
    const prepare = pod.initContainers.find(
      ({ name }: { name: string }) => name === "prepare-home",
    );
    const runtimeContainer = pod.containers.find(
      ({ name }: { name: string }) => name === "agentos",
    );
    const prepareEnvironment = Object.fromEntries(
      prepare.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    const runtimeEnvironment = Object.fromEntries(
      runtimeContainer.env.map(
        ({ name, value }: { name: string; value: string }) => [name, value],
      ),
    );

    expect(prepareEnvironment.AGENTOS_PI_PROVIDER_MODE).toBe("direct");
    expect(prepareEnvironment.AI_GATEWAY_URL).toBeUndefined();
    expect(prepareEnvironment.AI_GATEWAY_TOKEN).toBeUndefined();
    expect(prepareEnvironment.AGENTOS_MODEL).toBeUndefined();
    expect(runtimeEnvironment.AGENTOS_PI_PROVIDER_MODE).toBeUndefined();
    expect(runtimeEnvironment.AI_GATEWAY_URL).toBeUndefined();
    expect(runtimeEnvironment.AI_GATEWAY_TOKEN).toBeUndefined();
    expect(statefulSet.spec!.template.metadata.labels).not.toHaveProperty(
      "agentos.akua.dev/ai-gateway-client",
    );
  });

  test("renders the same persistent Mate base into isolated domain namespaces", async () => {
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
    ] as const;
    const rendered = await Promise.all(
      fixtures.map(async (fixture) => ({
        ...fixture,
        resources: await render(
          join(kubernetes, "tests", "fixtures", fixture.directory),
        ),
      })),
    );

    for (const fixture of rendered) {
      expect(
        fixture.resources
          .map(({ kind, metadata }) => `${kind}/${metadata.name}`)
          .sort(),
      ).toEqual([
        "Namespace/" + fixture.namespace,
        "NetworkPolicy/agentos-domain-ingress",
        "ResourceQuota/agentos-domain-capacity",
        "Role/agentos-firstmate-domain-supervisor",
        "Role/agentos-secondmate-workload-manager",
        "RoleBinding/agentos-firstmate-domain-supervisor-binding",
        "RoleBinding/agentos-secondmate-workload-manager-binding",
        "Service/agentos-secondmate",
        "ServiceAccount/agentos-secondmate",
        "StatefulSet/agentos-secondmate",
      ]);
      expect(
        fixture.resources
          .filter(({ kind }) => kind !== "Namespace")
          .every(
            ({ metadata }) => metadata.namespace === fixture.namespace,
          ),
      ).toBe(true);

      const namespace = namedResource(
        fixture.resources,
        "Namespace",
        fixture.namespace,
      );
      expect(namespace.metadata.labels).toEqual({
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
      const statefulSet = namedResource(
        fixture.resources,
        "StatefulSet",
        "agentos-secondmate",
      );
      const environment = Object.fromEntries(
        statefulSet.spec?.template.spec.containers[0].env.map(
          ({ name, value }: { name: string; value: string }) => [name, value],
        ),
      );
      expect(environment.AGENTOS_AGENT_ID).toBe(fixture.ownerAgentId);
    }

    const workloadIdentities = rendered.map(({ namespace, resources }) => {
      const statefulSet = namedResource(
        resources,
        "StatefulSet",
        "agentos-secondmate",
      );
      return `${namespace}/${statefulSet.kind}/${statefulSet.metadata.name}`;
    });
    expect(new Set(workloadIdentities).size).toBe(2);
  });

  test("grants child lifecycle authority without domain-control authority", async () => {
    const namespace = "agentos-domain-alpha";
    const resources = await render(
      join(kubernetes, "tests", "fixtures", "domain-alpha"),
    );
    const workloadRole = namedResource(
      resources,
      "Role",
      "agentos-secondmate-workload-manager",
    );
    expect(workloadRole.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["delete", "get", "list", "watch"],
      },
      {
        apiGroups: [""],
        resources: ["pods/exec"],
        verbs: ["create"],
      },
      {
        apiGroups: [""],
        resources: ["pods/log"],
        verbs: ["get"],
      },
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
    expect(JSON.stringify(workloadRole.rules)).not.toMatch(
      /secret|role|networkpolic|resourcequota|limitrange|namespace|\"\*\"/i,
    );

    const workloadBinding = namedResource(
      resources,
      "RoleBinding",
      "agentos-secondmate-workload-manager-binding",
    );
    expect({
      roleRef: workloadBinding.roleRef,
      subjects: workloadBinding.subjects,
    }).toEqual({
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "agentos-secondmate-workload-manager",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: "agentos-secondmate",
          namespace,
        },
      ],
    });

    const firstmateRole = namedResource(
      resources,
      "Role",
      "agentos-firstmate-domain-supervisor",
    );
    expect(JSON.stringify(firstmateRole.rules)).not.toContain('"*"');
    expect(firstmateRole.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resources: ["pods/exec"], verbs: ["create"] }),
        expect.objectContaining({
          resources: expect.arrayContaining(["secrets"]),
          verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
        }),
        expect.objectContaining({
          apiGroups: ["rbac.authorization.k8s.io"],
          resources: ["rolebindings", "roles"],
        }),
      ]),
    );
    const firstmateBinding = namedResource(
      resources,
      "RoleBinding",
      "agentos-firstmate-domain-supervisor-binding",
    );
    expect(firstmateBinding.subjects).toEqual([
      {
        kind: "ServiceAccount",
        name: "agentos-firstmate",
        namespace: "agentos",
      },
    ]);

    const quota = namedResource(
      resources,
      "ResourceQuota",
      "agentos-domain-capacity",
    );
    expect(quota.spec).toEqual({
      hard: {
        "count/persistentvolumeclaims": "16",
        "count/pods": "16",
        "count/services": "16",
        "count/services.loadbalancers": "0",
        "count/services.nodeports": "0",
        "count/statefulsets.apps": "16",
        "requests.storage": "320Gi",
      },
    });
    const ingress = namedResource(
      resources,
      "NetworkPolicy",
      "agentos-domain-ingress",
    );
    expect(ingress.spec).toEqual({
      ingress: [{ from: [{ podSelector: {} }] }],
      podSelector: {},
      policyTypes: ["Ingress"],
    });
  });
});
