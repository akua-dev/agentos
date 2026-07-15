import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      database: {
        cloudNativePG: {
          controllerImage:
            "ghcr.io/cloudnative-pg/cloudnative-pg@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb",
          manifestSha256:
            "f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88",
          manifestUrl:
            "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.0/cnpg-1.30.0.yaml",
          supportedKubernetesMinorVersions: ["1.34", "1.35", "1.36"],
          version: "1.30.0",
        },
        postgresImage:
          "ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie@sha256:b2c03bf5c6f8bc16495aacc0bb0765c77fe3e8ce6bc94ade26958f62ab9b4a14",
      },
      image,
      manifests: {
        clusterAdmin: "agentos-firstmate-cluster-admin.yaml",
        database: "agentos-postgres.yaml",
        scoped: "agentos-firstmate.yaml",
      },
      version: "0.1.0",
    });

    const scoped = parseResources(
      await readFile(join(outputDirectory, release.manifests.scoped), "utf8"),
    );
    const clusterAdmin = parseResources(
      await readFile(
        join(outputDirectory, release.manifests.clusterAdmin),
        "utf8",
      ),
    );
    const database = parseResources(
      await readFile(join(outputDirectory, release.manifests.database), "utf8"),
    );

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
          imageName: release.database.postgresImage,
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
