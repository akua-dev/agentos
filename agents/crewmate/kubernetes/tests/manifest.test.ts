import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: { name: string };
  spec?: Record<string, any>;
};

const kubernetes = new URL("..", import.meta.url).pathname;

async function render(): Promise<Resource[]> {
  const process = Bun.spawn(["kubectl", "kustomize", join(kubernetes, "base")], {
    stderr: "pipe",
    stdout: "pipe",
  });
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
    expect(statefulSet.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    const pod = statefulSet.spec?.template.spec;
    expect(pod.serviceAccountName).toBe("agentos-crewmate");
    expect(pod.containers).toHaveLength(1);
    const container = pod.containers[0];
    expect(
      [...pod.initContainers, container].map(
        ({ image }: { image: string }) => image,
      ),
    ).toEqual(["agentos:dev", "agentos:dev", "agentos:dev"]);
    const environment = Object.fromEntries(
      container.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(environment.AGENTOS_AGENT_ROLE).toBe("crewmate");
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(container.command).toEqual(["herdr"]);
    expect(container.args).toEqual([
      "server",
      "--session",
      "agentos-crewmate",
    ]);
  });
});
