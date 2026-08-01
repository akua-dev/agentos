import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../../../../src/access/identity.ts";

type Resource = {
  automountServiceAccountToken?: boolean;
  kind: string;
  metadata: {
    annotations?: Record<string, string>;
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

describe("Crewmate Kubernetes base", () => {
  test("renders one independently attachable Herdr runtime", async () => {
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
    const serviceAccount = resource(resources, "ServiceAccount");
    expect(serviceAccount.automountServiceAccountToken).toBe(false);
    expect(pod.serviceAccountName).toBe("agentos-crewmate");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.initContainers).toHaveLength(3);
    expect(pod.containers).toHaveLength(1);
    const install = pod.initContainers[0];
    const prepare = pod.initContainers[1];
    const container = pod.containers[0];
    expect(
      [...pod.initContainers, container].map(
        ({ image }: { image: string }) => image,
      ),
    ).toEqual([
      "agentos:dev",
      "agentos:dev",
      "agentos:dev",
      "agentos:dev",
    ]);
    expect(
      [...pod.initContainers, container].map(
        ({ resources }: { resources: Record<string, unknown> }) => resources,
      ),
    ).toEqual([
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
    ]);
    expect(
      [...pod.initContainers, container].map(
        ({ workingDir }: { workingDir?: string }) => workingDir,
      ),
    ).toEqual([
      "/opt/agentos/packages/agentos/resources/crewmates/default",
      "/opt/agentos/packages/agentos/resources/crewmates/default",
      undefined,
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
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
    );
    expect(environment.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(container.command).toEqual(["herdr"]);
    expect(container.args).toEqual(["server", "--session", "agentos-crewmate"]);
    expect(container.livenessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "crewmate:health",
      "--",
      "live",
    ]);
    expect(container.readinessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "crewmate:health",
      "--",
      "ready",
    ]);
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.volumeMounts).toEqual([
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
        secret: {
          defaultMode: 288,
          secretName: "agentos-crewmate-postgres",
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
      "agentos.akua.dev/agentgateway-client": "true",
    });
    expect(environment.AI_GATEWAY_URL).toBe(
      "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    );
    expect(environment.AI_GATEWAY_TOKEN).toBeUndefined();
    expect(environment.AGENTOS_CODEX_PROVIDER_MODE).toBe("ai-gateway");
    expect(environment.AGENTOS_EGRESS_TOKEN_FILE).toBe(
      "/var/run/secrets/agentos-egress/token",
    );
    expect(prepareEnvironment).toMatchObject({
      AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
      AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
      AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
      AI_GATEWAY_URL:
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    });
    expect(environment.AGENTOS_PROVIDER_CREDENTIAL_KIND).toBe("ai_gateway");
    expect(pod.serviceAccountName).toBe("agentos-crewmate");
    expect(spec.volumeClaimTemplates[0].metadata.name).toBe("home");
  });

  test("renders an explicit one-rollout return to direct Codex auth", async () => {
    const resources = await render(
      join(kubernetes, "tests", "fixtures", "ai-gateway-direct-auth"),
    );
    const statefulSet = resource(resources, "StatefulSet");
    const pod = statefulSet.spec!.template.spec;
    const prepare = pod.initContainers.find(
      ({ name }: { name: string }) => name === "prepare-home",
    );
    const container = pod.containers.find(
      ({ name }: { name: string }) => name === "crewmate",
    );
    const prepareEnvironment = Object.fromEntries(
      prepare.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    const environment = Object.fromEntries(
      container.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );

    expect(prepareEnvironment.AGENTOS_CODEX_PROVIDER_MODE).toBe("direct");
    expect(prepareEnvironment.AGENTOS_ASSIGNMENT_ID).toBe(
      "00000000-0000-4000-8000-000000000005",
    );
    expect(prepareEnvironment.AI_GATEWAY_URL).toBeUndefined();
    expect(environment.AGENTOS_CODEX_PROVIDER_MODE).toBeUndefined();
    expect(environment.AGENTOS_ASSIGNMENT_ID).toBe(
      "00000000-0000-4000-8000-000000000005",
    );
    expect(environment.AI_GATEWAY_URL).toBeUndefined();
    expect(statefulSet.spec!.template.metadata.labels).not.toHaveProperty(
      "agentos.akua.dev/agentgateway-client",
    );
  });
});
