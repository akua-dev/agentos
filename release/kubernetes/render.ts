#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Crypto,
  Effect,
  FileSystem,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parseAllDocuments } from "yaml";

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const ResourceSchema = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    labels: Schema.optional(StringRecordSchema),
    name: Schema.String,
  }),
  spec: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type Resource = typeof ResourceSchema.Type;

const ContainerSchema = Schema.Struct({
  image: Schema.String,
  imagePullPolicy: Schema.String,
});
const FirstMateStatefulSetSchema = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({
    labels: StringRecordSchema,
    name: Schema.Literal("agentos-firstmate"),
  }),
  spec: Schema.Struct({
    template: Schema.Struct({
      metadata: Schema.Struct({ labels: StringRecordSchema }),
      spec: Schema.Struct({
        initContainers: Schema.Array(ContainerSchema),
        containers: Schema.Array(ContainerSchema),
      }),
    }),
  }),
});
const isFirstMateStatefulSet = Schema.is(FirstMateStatefulSetSchema);

const DatabaseClusterSchema = Schema.Struct({
  kind: Schema.Literal("Cluster"),
  metadata: Schema.Struct({
    labels: StringRecordSchema,
    name: Schema.Literal("agentos-postgres"),
  }),
  spec: Schema.Record(Schema.String, Schema.Unknown),
});
const isDatabaseCluster = Schema.is(DatabaseClusterSchema);

export const ReleaseSchema = Schema.Struct({
  image: Schema.String,
  manifests: Schema.Struct({
    clusterAdmin: Schema.String,
    database: Schema.String,
    scoped: Schema.String,
  }),
  version: Schema.String,
});
export type Release = typeof ReleaseSchema.Type;
const ReleaseFromString = Schema.fromJsonString(ReleaseSchema);

export type RenderReleaseOptions = {
  readonly image: string;
  readonly outputDirectory: string;
  readonly version: string;
};

const ReleaseErrorCodeSchema = Schema.Literals([
  "configuration",
  "filesystem",
  "invalid_image",
  "invalid_manifest",
  "invalid_version",
  "kubectl",
  "output",
]);

export class ReleaseRenderError extends Schema.TaggedErrorClass<ReleaseRenderError>()(
  "ReleaseRenderError",
  {
    code: ReleaseErrorCodeSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  },
) {
  override readonly [Runtime.errorExitCode] = this.code === "configuration" ||
      this.code === "invalid_image" ||
      this.code === "invalid_version"
    ? 2
    : 1;
}

const releaseError = (
  code: ReleaseRenderError["code"],
  message: string,
  options?: { readonly cause?: unknown; readonly exitCode?: number },
) => new ReleaseRenderError({ code, message, ...options });

type ReleaseVariant = {
  readonly filename: string;
  readonly kustomization: string;
  readonly validate: (
    resources: ReadonlyArray<Resource>,
  ) => Effect.Effect<void, ReleaseRenderError>;
};

export const renderRelease = Effect.fn("agentos.release.render")(function*(
  { image, outputDirectory, version }: RenderReleaseOptions,
) {
  yield* validateImmutableImage(image);
  yield* validateVersion(version);

  const release: Release = {
    image,
    manifests: {
      clusterAdmin: "agentos-firstmate-cluster-admin.yaml",
      database: "agentos-postgres.yaml",
      scoped: "agentos-firstmate.yaml",
    },
    version,
  };
  const variants: ReadonlyArray<ReleaseVariant> = [
    {
      kustomization: firstMateKustomization(
        "../packages/agentos/resources/roles/firstmate/kubernetes/base",
        image,
        version,
      ),
      filename: release.manifests.scoped,
      validate: (resources) => validateFirstMate(resources, image, version),
    },
    {
      kustomization: firstMateKustomization(
        "../packages/agentos/resources/roles/firstmate/kubernetes/overlays/cluster-admin",
        image,
        version,
      ),
      filename: release.manifests.clusterAdmin,
      validate: (resources) => validateFirstMate(resources, image, version),
    },
    {
      kustomization: databaseKustomization(version),
      filename: release.manifests.database,
      validate: (resources) => validateDatabase(resources, version),
    },
  ];
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const repositoryRoot = yield* paths.fromFileUrl(
    new URL("../..", import.meta.url),
  ).pipe(
    Effect.mapError((cause) =>
      releaseError("configuration", "Could not resolve the repository root", {
        cause,
      })
    ),
  );

  yield* fileSystem.makeDirectory(outputDirectory, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      releaseError(
        "filesystem",
        `Could not create release output directory: ${outputDirectory}`,
        { cause },
      )
    ),
  );
  yield* Effect.forEach(
    variants,
    (variant) => renderVariant(repositoryRoot, outputDirectory, variant),
    { concurrency: "unbounded", discard: true },
  );
  return release;
});

const renderVariant = Effect.fn("agentos.release.renderVariant")(function*(
  repositoryRoot: string,
  outputDirectory: string,
  variant: ReleaseVariant,
) {
  const rendered = yield* Effect.scoped(Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const overlay = yield* fileSystem.makeTempDirectoryScoped({
      directory: repositoryRoot,
      prefix: ".agentos-release-",
    }).pipe(
      Effect.mapError((cause) =>
        releaseError("filesystem", "Could not create release overlay", { cause })
      ),
    );
    yield* fileSystem.writeFileString(
      paths.join(overlay, "kustomization.yaml"),
      variant.kustomization,
    ).pipe(
      Effect.mapError((cause) =>
        releaseError("filesystem", "Could not write release overlay", { cause })
      ),
    );
    return yield* runKustomize(overlay);
  }));
  const resources = yield* decodeResources(rendered);
  yield* variant.validate(resources);
  yield* writeFileAtomic(outputDirectory, variant.filename, rendered);
});

const runKustomize = Effect.fn("agentos.release.kustomize")(function*(
  overlay: string,
) {
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("kubectl", ["kustomize", overlay], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(
    Effect.mapError((cause) =>
      releaseError("kubectl", "Could not execute kubectl kustomize", { cause })
    ),
  );
  if (result.exitCode !== 0) {
    return yield* releaseError(
      "kubectl",
      `kubectl kustomize failed with exit ${result.exitCode}${
        result.stderr.trim() ? `: ${result.stderr.trim()}` : ""
      }`,
      { exitCode: result.exitCode },
    );
  }
  return result.stdout;
});

const decodeResources = Effect.fn("agentos.release.decodeResources")(
  function*(rendered: string) {
    const documents = yield* Effect.try({
      try: () => parseAllDocuments(rendered),
      catch: (cause) =>
        releaseError("invalid_manifest", "Rendered release is not valid YAML", {
          cause,
        }),
    });
    const issue = documents.flatMap((document) => document.errors).at(0);
    if (issue !== undefined) {
      return yield* releaseError(
        "invalid_manifest",
        "Rendered release is not valid YAML",
        { cause: issue },
      );
    }
    const values = yield* Effect.try({
      try: () => documents.map((document) => document.toJS()),
      catch: (cause) =>
        releaseError("invalid_manifest", "Could not decode rendered YAML", {
          cause,
        }),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(ResourceSchema))(
      values,
    ).pipe(
      Effect.mapError((cause) =>
        releaseError(
          "invalid_manifest",
          "Rendered release does not contain Kubernetes resources",
          { cause },
        )
      ),
    );
  },
);

const writeFileAtomic = Effect.fn("agentos.release.writeFileAtomic")(
  function*(directory: string, filename: string, contents: string) {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const destination = paths.join(directory, filename);
    const identifier = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        releaseError("filesystem", "Could not create an atomic output name", {
          cause,
        })
      ),
    );
    const temporary = paths.join(
      directory,
      `.${filename}.${identifier}.tmp`,
    );
    yield* fileSystem.writeFileString(temporary, contents).pipe(
      Effect.andThen(fileSystem.rename(temporary, destination)),
      Effect.ensuring(
        fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) =>
        releaseError(
          "filesystem",
          `Could not publish release manifest: ${filename}`,
          { cause },
        )
      ),
    );
  },
);

function validateImmutableImage(image: string) {
  return /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/
      .test(image)
    ? Effect.void
    : Effect.fail(releaseError(
      "invalid_image",
      "Release image must use an immutable sha256 digest.",
    ));
}

function validateVersion(version: string) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? Effect.void
    : Effect.fail(releaseError(
      "invalid_version",
      "Release version must be semantic version text without a v prefix.",
    ));
}

function validateFirstMate(
  resources: ReadonlyArray<Resource>,
  image: string,
  version: string,
) {
  const statefulSet = resources.find(isFirstMateStatefulSet);
  if (statefulSet === undefined) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release is missing a valid StatefulSet/agentos-firstmate.",
    ));
  }
  if (statefulSet.metadata.labels["app.kubernetes.io/version"] !== version) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release is missing the First Mate version label.",
    ));
  }
  if (
    statefulSet.spec.template.metadata.labels["app.kubernetes.io/version"] !==
      version
  ) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release is missing the First Mate Pod version label.",
    ));
  }
  const pod = statefulSet.spec.template.spec;
  const containers = [...pod.initContainers, ...pod.containers];
  if (containers.length !== 4) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      `Expected four First Mate containers, found ${containers.length}.`,
    ));
  }
  if (
    containers.some((container) =>
      container.image !== image || container.imagePullPolicy !== "IfNotPresent"
    )
  ) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release did not pin every First Mate container.",
    ));
  }
  return Effect.void;
}

function validateDatabase(
  resources: ReadonlyArray<Resource>,
  version: string,
) {
  const cluster = resources.find(isDatabaseCluster);
  if (cluster === undefined) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release is missing a valid Cluster/agentos-postgres.",
    ));
  }
  if ("imageName" in cluster.spec) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Released database manifest must leave PostgreSQL version selection to First Mate.",
    ));
  }
  if (cluster.metadata.labels["app.kubernetes.io/version"] !== version) {
    return Effect.fail(releaseError(
      "invalid_manifest",
      "Rendered release is missing the database version label.",
    ));
  }
  return Effect.void;
}

function firstMateKustomization(
  resource: string,
  image: string,
  version: string,
): string {
  const [newName = "", digest = ""] = image.split("@");
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
              - name: prepare-github-provider
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

export const parseArguments = Effect.fn("agentos.release.parseArguments")(
  function*(arguments_: ReadonlyArray<string>) {
    const values = new Map<string, string>();
    for (let index = 0; index < arguments_.length; index += 2) {
      const name = arguments_[index];
      const value = arguments_[index + 1];
      if (name === undefined || !name.startsWith("--") || value === undefined) {
        return yield* usageError;
      }
      values.set(name.slice(2), value);
    }
    const image = values.get("image");
    const outputDirectory = values.get("output");
    const version = values.get("version");
    if (
      image === undefined ||
      outputDirectory === undefined ||
      version === undefined ||
      values.size !== 3
    ) {
      return yield* usageError;
    }
    return { image, outputDirectory, version };
  },
);

const usage =
  "Usage: render.ts --image <name@sha256:digest> --version <semver> --output <directory>";
const usageError = releaseError("configuration", usage);

export const runReleaseRenderer = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const options = yield* parseArguments(yield* stdio.args);
  const release = yield* renderRelease(options);
  const encoded = yield* Schema.encodeEffect(ReleaseFromString)(release).pipe(
    Effect.mapError((cause) =>
      releaseError("output", "Could not encode release metadata", { cause })
    ),
  );
  yield* Stream.make(`${encoded}\n`).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError((cause) =>
      releaseError("output", "Could not write release metadata", { cause })
    ),
  );
});

const reportFailure = (error: ReleaseRenderError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  BunRuntime.runMain(
    runReleaseRenderer.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
