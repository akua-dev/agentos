import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: {
    labels?: Record<string, string>;
    name: string;
    namespace?: string;
  };
  spec?: Record<string, any>;
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
    const environment = Object.fromEntries(
      container.env.map(
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
    expect(pod.serviceAccountName).toBe("agentos-secondmate");
    expect(spec.volumeClaimTemplates[0].metadata.name).toBe("home");
  });
});
