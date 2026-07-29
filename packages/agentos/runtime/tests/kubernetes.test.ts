import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: { name: string };
  spec?: Record<string, any>;
};

const kubernetes = new URL("../kubernetes", import.meta.url).pathname;

async function render(directory: string): Promise<Resource[]> {
  const process = Bun.spawn(["kubectl", "kustomize", directory], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const parsed = Bun.YAML.parse(stdout) as Resource | Resource[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function statefulSet(resources: Resource[]) {
  const match = resources.find(({ kind }) => kind === "StatefulSet");
  if (!match) throw new Error("Missing StatefulSet");
  return match;
}

function environment(container: { env: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
}

describe("persistent Agent Kubernetes runtime", () => {
  test("keeps only retained-home and Herdr invariants in the neutral base", async () => {
    const workload = statefulSet(await render(join(kubernetes, "base")));
    expect(workload.metadata.name).toBe("agentos-agent");
    expect(workload.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(workload.spec?.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      },
    ]);

    const pod = workload.spec?.template.spec;
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.initContainers).toHaveLength(1);
    expect(pod.containers).toHaveLength(1);

    const install = pod.initContainers[0];
    const agent = pod.containers[0];
    expect(install.args).toEqual([
      "install",
      "--locked",
      "node",
      "kubectl",
      "github:ogulcancelik/herdr",
    ]);
    expect(agent.command).toEqual(["herdr"]);
    expect(agent.args).toEqual(["server", "--session", "agentos-agent"]);
    expect(environment(agent).PI_CODING_AGENT_DIR).toBeUndefined();
    expect(environment(agent).PI_OAUTH_CALLBACK_HOST).toBeUndefined();
    expect(agent.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(agent.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
    ]);
  });

  test("adds the persistent Pi lifecycle only in the Mate layer", async () => {
    const workload = statefulSet(await render(join(kubernetes, "mate")));
    expect(workload.metadata.name).toBe("agentos-agent");
    const pod = workload.spec?.template.spec;
    expect(pod.initContainers).toHaveLength(2);
    expect(pod.containers).toHaveLength(1);

    const install = pod.initContainers[0];
    const prepare = pod.initContainers[1];
    const mate = pod.containers[0];
    expect(install.args).toEqual([
      "install",
      "--locked",
      "node",
      "kubectl",
      "github:ogulcancelik/herdr",
      "npm:@earendil-works/pi-coding-agent",
    ]);
    expect(prepare.args).toEqual(["run", "--skip-tools", "mate:prepare"]);
    expect(mate.command).toEqual(["mise"]);
    expect(mate.args).toEqual(["run", "--skip-tools", "mate:run"]);
    expect(environment(mate)).toMatchObject({
      PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
      PI_OAUTH_CALLBACK_HOST: "0.0.0.0",
    });
    expect(mate.livenessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "mate:health",
      "--",
      "live",
    ]);
    expect(mate.readinessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "mate:health",
      "--",
      "ready",
    ]);
  });
});
