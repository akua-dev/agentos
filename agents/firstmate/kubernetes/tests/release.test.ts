import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRelease } from "../release/render.ts";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { labels?: Record<string, string>; name: string; namespace?: string };
  spec?: Record<string, any>;
};

const temporaryDirectories: string[] = [];
const image = `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("First Mate release artifacts", () => {
  test("renders scoped and dedicated-cluster manifests from one immutable image", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "agentos-release-"));
    temporaryDirectories.push(outputDirectory);

    const release = await renderRelease({
      image,
      outputDirectory,
      version: "0.1.0",
    });

    expect(release).toEqual({
      image,
      manifests: {
        clusterAdmin: "agentos-firstmate-cluster-admin.yaml",
        database: "agentos-postgres.yaml",
        scoped: "agentos-firstmate.yaml",
      },
      version: "0.1.0",
    });

    const scopedManifest = await readFile(
      join(outputDirectory, release.manifests.scoped),
      "utf8",
    );
    const clusterAdminManifest = await readFile(
      join(outputDirectory, release.manifests.clusterAdmin),
      "utf8",
    );
    const databaseManifest = await readFile(
      join(outputDirectory, release.manifests.database),
      "utf8",
    );
    const scoped = parseResources(scopedManifest);
    const clusterAdmin = parseResources(clusterAdminManifest);
    const database = parseResources(databaseManifest);

    for (const manifest of [
      scopedManifest,
      clusterAdminManifest,
      databaseManifest,
    ]) {
      expect(manifest).toMatch(/^apiVersion: [^\n]+\nkind: [^\n]+\n/);
      expect(manifest).not.toMatch(/^\{.*\}$/m);
    }

    expect((await readdir(outputDirectory)).sort()).toEqual([
      "agentos-firstmate-cluster-admin.yaml",
      "agentos-firstmate.yaml",
      "agentos-postgres.yaml",
    ]);

    expect(scoped.some(({ kind }) => kind === "ClusterRoleBinding")).toBe(false);
    expect(clusterAdmin.some(({ kind }) => kind === "ClusterRoleBinding")).toBe(true);
    for (const resources of [scoped, clusterAdmin]) {
      const statefulSet = resources.find(
        ({ kind, metadata }) =>
          kind === "StatefulSet" && metadata.name === "agentos-firstmate",
      );
      expect(statefulSet?.metadata.labels?.["app.kubernetes.io/version"]).toBe(
        "0.1.0",
      );
      const pod = statefulSet?.spec?.template.spec;
      const containers = [...pod.initContainers, ...pod.containers];
      expect(containers.map(({ image: value }: { image: string }) => value)).toEqual([
        image,
        image,
        image,
      ]);
      expect(
        containers.map(
          ({ imagePullPolicy }: { imagePullPolicy: string }) => imagePullPolicy,
        ),
      ).toEqual(["IfNotPresent", "IfNotPresent", "IfNotPresent"]);
    }
    expect(database).toEqual([
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: {
          labels: {
            "app.kubernetes.io/name": "agentos-postgres",
            "app.kubernetes.io/part-of": "agentos",
            "app.kubernetes.io/version": "0.1.0",
          },
          name: "agentos-postgres",
          namespace: "agentos",
        },
        spec: {
          bootstrap: {
            initdb: {
              dataChecksums: true,
              database: "agentos",
              owner: "agentos",
            },
          },
          enableSuperuserAccess: false,
          instances: 1,
          storage: { size: "20Gi" },
        },
      },
    ]);
  });

  test("rejects a mutable release image", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "agentos-release-"));
    temporaryDirectories.push(outputDirectory);

    expect(
      renderRelease({
        image: "ghcr.io/akua-dev/agentos:latest",
        outputDirectory,
        version: "0.1.0",
      }),
    ).rejects.toThrow("immutable sha256 digest");
  });
});

function parseResources(manifest: string): Resource[] {
  const parsed = Bun.YAML.parse(manifest) as Resource | Resource[];
  return Array.isArray(parsed) ? parsed : [parsed];
}
