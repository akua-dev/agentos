import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: {
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    name: string;
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

describe("Crewmate Kubernetes base", () => {
  test("renders one independently attachable Herdr runtime", async () => {
    const resources = await render();
    expect(resources.map(({ kind }) => kind).sort()).toEqual([
      "Service",
      "ServiceAccount",
      "StatefulSet",
    ]);

    const statefulSet = resource(resources, "StatefulSet");
    expect(statefulSet.metadata.name).toBe("agentos-crewmate");
    expect(statefulSet.spec?.serviceName).toBe("agentos-crewmate");
    expect(statefulSet.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(statefulSet.spec?.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      },
    ]);
    const pod = statefulSet.spec?.template.spec;
    expect(statefulSet.spec?.template.metadata).toEqual({
      annotations: {
        "agentos.akua.dev/container": "crewmate",
        "agentos.akua.dev/herdr-session": "agentos-crewmate",
      },
      labels: {
        "agentos.akua.dev/agent": "crewmate",
        "agentos.akua.dev/otel-client": "true",
        "app.kubernetes.io/name": "agentos-crewmate",
        "app.kubernetes.io/part-of": "agentos",
      },
    });
    expect(pod.serviceAccountName).toBe("agentos-crewmate");
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.initContainers).toHaveLength(2);
    expect(pod.containers).toHaveLength(1);
    const install = pod.initContainers[0];
    const prepare = pod.initContainers[1];
    const container = pod.containers[0];
    expect(
      [...pod.initContainers, container].map(
        ({ image }: { image: string }) => image,
      ),
    ).toEqual(["agentos:dev", "agentos:dev", "agentos:dev"]);
    expect(
      [install, prepare, container].map(
        ({ workingDir }: { workingDir: string }) => workingDir,
      ),
    ).toEqual([
      "/opt/agentos/packages/agentos/resources/crewmates/default",
      "/opt/agentos/packages/agentos/resources/crewmates/default",
      "/opt/agentos/packages/agentos/resources/crewmates/default",
    ]);
    expect(install.command).toEqual(["mise"]);
    expect(install.args).toEqual([
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
    expect(prepare.command).toEqual(["mise"]);
    expect(prepare.args).toEqual(["run", "--skip-tools", "crewmate:prepare"]);
    const environment = Object.fromEntries(
      container.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(environment).toMatchObject({
      AGENTOS_AGENT_CWD:
        "/opt/agentos/packages/agentos/resources/crewmates/default",
      AGENTOS_DISTRIBUTION_ROOT: "/opt/agentos/packages/agentos",
      AGENTOS_AGENT_ID: "00000000-0000-4000-8000-000000000003",
      AGENTOS_AGENT_NAME: "crewmate",
      AGENTOS_AGENT_ROLE: "crewmate",
      AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
      AGENTOS_BRIEF_PATH: "/home/agent/brief.md",
      AGENTOS_DATABASE_URL:
        "postgresql://runtime_crewmate@agentos-postgres-rw.agentos.svc:5432/agentos?sslmode=require",
      AGENTOS_PGPASS_SOURCE: "/var/run/secrets/agentos/pgpass",
      AGENTOS_TASK_ID: "00000000-0000-4000-8000-000000000004",
      HERDR_SESSION: "agentos-crewmate",
      PGPASSFILE: "/home/agent/.pgpass",
    });
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(environment.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(container.command).toEqual(["herdr"]);
    expect(container.args).toEqual(["server", "--session", "agentos-crewmate"]);
    expect(container.livenessProbe.exec.command).toEqual([
      "herdr",
      "status",
      "--json",
      "--session",
      "agentos-crewmate",
    ]);
    expect(container.readinessProbe.exec.command).toEqual(
      container.livenessProbe.exec.command,
    );
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
    ]);
    expect(prepare.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
      {
        mountPath: "/var/run/secrets/agentos",
        name: "database-credentials",
        readOnly: true,
      },
    ]);
    expect(pod.volumes).toEqual([
      {
        name: "database-credentials",
        secret: { secretName: "agentos-crewmate-postgres" },
      },
    ]);
  });

  test("adds only the approved Fleet AI Gateway client boundary", async () => {
    const resources = await render(
      join(kubernetes, "tests", "fixtures", "ai-gateway-client"),
    );
    const statefulSet = resource(resources, "StatefulSet");
    const spec = statefulSet.spec!;
    const pod = spec.template.spec;
    const container = pod.containers.find(
      ({ name }: { name: string }) => name === "crewmate",
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
    expect(pod.serviceAccountName).toBe("agentos-crewmate");
    expect(spec.volumeClaimTemplates[0].metadata.name).toBe("home");
  });
});
