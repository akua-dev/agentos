import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Record<string, any>;
};

const databaseDirectory = new URL("..", import.meta.url).pathname;

async function render(directory: string): Promise<Resource[]> {
  const child = Bun.spawn(["kubectl", "kustomize", directory], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const parsed = Bun.YAML.parse(stdout) as Resource | Resource[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe("AgentOS self-hosted PostgreSQL", () => {
  test("renders one minimal CloudNativePG fleet database", async () => {
    const resources = await render(join(databaseDirectory, "base"));

    expect(resources).toHaveLength(1);
    const cluster = resources[0];
    expect({
      apiVersion: cluster?.apiVersion,
      kind: cluster?.kind,
      name: cluster?.metadata.name,
      namespace: cluster?.metadata.namespace,
    }).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      name: "agentos-postgres",
      namespace: "agentos",
    });
    expect(cluster?.spec).toEqual({
      bootstrap: {
        initdb: {
          dataChecksums: true,
          database: "agentos",
          owner: "agentos",
        },
      },
      enableSuperuserAccess: false,
      imageName:
        "ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie@sha256:b2c03bf5c6f8bc16495aacc0bb0765c77fe3e8ce6bc94ade26958f62ab9b4a14",
      instances: 1,
      storage: { size: "20Gi" },
    });
  });
});
