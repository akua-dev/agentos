#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
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
    scoped: string;
  };
  version: string;
};

type RenderReleaseOptions = {
  image: string;
  outputDirectory: string;
  version: string;
};

const firstmateDirectory = new URL("..", import.meta.url).pathname.replace(
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
      scoped: "agentos-firstmate.yaml",
    },
    version,
  };
  const variants = [
    {
      directory: join(firstmateDirectory, "base"),
      filename: release.manifests.scoped,
    },
    {
      directory: join(
        firstmateDirectory,
        "overlays",
        "cluster-admin",
      ),
      filename: release.manifests.clusterAdmin,
    },
  ];

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    variants.map(async ({ directory, filename }) => {
      const rendered = await $`kubectl kustomize ${directory}`.text();
      const resources = Bun.YAML.parse(rendered) as Resource[];
      configureRelease(resources, image, version);
      await writeFile(
        join(outputDirectory, filename),
        serializeResources(resources),
        "utf8",
      );
    }),
  );
  await writeFile(
    join(outputDirectory, "release.json"),
    `${JSON.stringify({ schemaVersion: 1, ...release }, null, 2)}\n`,
    "utf8",
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

function configureRelease(resources: Resource[], image: string, version: string) {
  const statefulSet = resources.find(
    ({ kind, metadata }) =>
      kind === "StatefulSet" && metadata.name === "agentos-firstmate",
  );
  if (!statefulSet?.spec?.template?.spec) {
    throw new Error("Rendered release is missing StatefulSet/agentos-firstmate.");
  }

  statefulSet.metadata.labels = {
    ...statefulSet.metadata.labels,
    "app.kubernetes.io/version": version,
  };
  statefulSet.spec.template.metadata.labels = {
    ...statefulSet.spec.template.metadata.labels,
    "app.kubernetes.io/version": version,
  };
  const pod = statefulSet.spec.template.spec;
  const containers = [...pod.initContainers, ...pod.containers];
  if (containers.length !== 3) {
    throw new Error(`Expected three First Mate containers, found ${containers.length}.`);
  }
  for (const container of containers) {
    container.image = image;
    container.imagePullPolicy = "IfNotPresent";
  }
}

function serializeResources(resources: Resource[]): string {
  return `${resources
    .map((resource) => Bun.YAML.stringify(resource).trimEnd())
    .join("\n---\n")}\n`;
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
