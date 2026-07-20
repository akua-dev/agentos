#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Resource = {
  kind: string;
  metadata: {
    labels?: Record<string, string>;
    name: string;
  };
  spec?: Record<string, any>;
};

export type Release = {
  image: string;
  manifests: {
    clusterAdmin: string;
    database: string;
    scoped: string;
  };
  version: string;
};

type RenderReleaseOptions = {
  image: string;
  outputDirectory: string;
  version: string;
};

const repositoryRoot = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

export async function renderRelease({
  image,
  outputDirectory,
  version,
}: RenderReleaseOptions): Promise<Release> {
  assertImmutableImage(image);
  assertVersion(version);

  const release: Release = {
    image,
    manifests: {
      clusterAdmin: "agentos-firstmate-cluster-admin.yaml",
      database: "agentos-postgres.yaml",
      scoped: "agentos-firstmate.yaml",
    },
    version,
  };
  const variants = [
    {
      kustomization: firstMateKustomization(
        "../agents/firstmate/kubernetes/base",
        image,
        version,
      ),
      filename: release.manifests.scoped,
      validate: (resources: Resource[]) =>
        validateFirstMate(resources, image, version),
    },
    {
      kustomization: firstMateKustomization(
        "../agents/firstmate/kubernetes/overlays/cluster-admin",
        image,
        version,
      ),
      filename: release.manifests.clusterAdmin,
      validate: (resources: Resource[]) =>
        validateFirstMate(resources, image, version),
    },
    {
      kustomization: databaseKustomization(version),
      filename: release.manifests.database,
      validate: (resources: Resource[]) => validateDatabase(resources, version),
    },
  ];

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    variants.map(async ({ filename, kustomization, validate }) => {
      const overlay = await mkdtemp(
        join(repositoryRoot, ".agentos-release-"),
      );
      try {
        await writeFile(join(overlay, "kustomization.yaml"), kustomization, "utf8");
        const rendered = await $`kubectl kustomize ${overlay}`.text();
        const parsed = Bun.YAML.parse(rendered) as Resource | Resource[];
        const resources = Array.isArray(parsed) ? parsed : [parsed];
        validate(resources);
        await writeFile(join(outputDirectory, filename), rendered, "utf8");
      } finally {
        await rm(overlay, { force: true, recursive: true });
      }
    }),
  );
  return release;
}

function assertImmutableImage(image: string) {
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("Release image must use an immutable sha256 digest.");
  }
}

function assertVersion(version: string) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Release version must be semantic version text without a v prefix.");
  }
}

function validateFirstMate(resources: Resource[], image: string, version: string) {
  const statefulSet = resources.find(
    ({ kind, metadata }) =>
      kind === "StatefulSet" && metadata.name === "agentos-firstmate",
  );
  if (!statefulSet?.spec?.template?.spec) {
    throw new Error("Rendered release is missing StatefulSet/agentos-firstmate.");
  }

  if (statefulSet.metadata.labels?.["app.kubernetes.io/version"] !== version) {
    throw new Error("Rendered release is missing the First Mate version label.");
  }
  if (
    statefulSet.spec.template.metadata.labels?.["app.kubernetes.io/version"] !==
    version
  ) {
    throw new Error("Rendered release is missing the First Mate Pod version label.");
  }
  const pod = statefulSet.spec.template.spec;
  const containers = [...pod.initContainers, ...pod.containers];
  if (containers.length !== 3) {
    throw new Error(`Expected three First Mate containers, found ${containers.length}.`);
  }
  for (const container of containers) {
    if (container.image !== image || container.imagePullPolicy !== "IfNotPresent") {
      throw new Error("Rendered release did not pin every First Mate container.");
    }
  }
}

function validateDatabase(
  resources: Resource[],
  version: string,
) {
  const cluster = resources.find(
    ({ kind, metadata }) =>
      kind === "Cluster" && metadata.name === "agentos-postgres",
  );
  if (!cluster?.spec) {
    throw new Error("Rendered release is missing Cluster/agentos-postgres.");
  }
  if ("imageName" in cluster.spec) {
    throw new Error(
      "Released database manifest must leave PostgreSQL version selection to First Mate.",
    );
  }
  if (cluster.metadata.labels?.["app.kubernetes.io/version"] !== version) {
    throw new Error("Rendered release is missing the database version label.");
  }
}

function firstMateKustomization(
  resource: string,
  image: string,
  version: string,
): string {
  const [newName, digest] = image.split("@");
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ${resource}
images:
  - name: agentos
    newName: ${newName}
    digest: ${digest}
patches:
  - target:
      group: apps
      version: v1
      kind: StatefulSet
      name: agentos-firstmate
    patch: |-
      apiVersion: apps/v1
      kind: StatefulSet
      metadata:
        name: agentos-firstmate
        labels:
          app.kubernetes.io/version: ${version}
      spec:
        template:
          metadata:
            labels:
              app.kubernetes.io/version: ${version}
          spec:
            initContainers:
              - name: install-tools
                imagePullPolicy: IfNotPresent
              - name: prepare-home
                imagePullPolicy: IfNotPresent
            containers:
              - name: agentos
                imagePullPolicy: IfNotPresent
`;
}

function databaseKustomization(version: string): string {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../database/kubernetes/cloudnative-pg
patches:
  - target:
      group: postgresql.cnpg.io
      version: v1
      kind: Cluster
      name: agentos-postgres
    patch: |-
      apiVersion: postgresql.cnpg.io/v1
      kind: Cluster
      metadata:
        name: agentos-postgres
        labels:
          app.kubernetes.io/version: ${version}
`;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const release = await renderRelease(options);
  console.log(JSON.stringify(release));
}

function parseArguments(arguments_: string[]): RenderReleaseOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const image = values.get("image");
  const outputDirectory = values.get("output");
  const version = values.get("version");
  if (!image || !outputDirectory || !version || values.size !== 3) usage();
  return { image, outputDirectory, version };
}

function usage(): never {
  console.error(
    "Usage: render.ts --image <name@sha256:digest> --version <semver> --output <directory>",
  );
  process.exit(2);
}
