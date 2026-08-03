import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parse as parseYaml, parseAllDocuments } from "yaml";

import { renderRelease } from "../render.ts";

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const ResourceSchema = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    labels: Schema.optional(StringRecordSchema),
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
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
      spec: Schema.Struct({
        initContainers: Schema.Array(ContainerSchema),
        containers: Schema.Array(ContainerSchema),
      }),
    }),
  }),
});
const isFirstMateStatefulSet = Schema.is(FirstMateStatefulSetSchema);

const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.Array(Schema.Struct({
        uses: Schema.optional(Schema.String),
        with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      })),
    }),
  ),
});

const image = `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;

const parseResources = Effect.fn("test.release.parseResources")(
  function*(manifest: string) {
    const values = yield* Effect.try({
      try: () => parseAllDocuments(manifest).map((document) => document.toJS()),
      catch: (cause) => cause,
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(ResourceSchema))(values);
  },
);

const run = Effect.fn("test.release.run")(function*(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, args, {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

describe("First Mate release artifacts", () => {
  it.effect("logs both release jobs in to GHCR with only the repository token", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("../../..", import.meta.url));
      const source = yield* fileSystem.readFileString(
        paths.join(root, ".github", "workflows", "release.yml"),
      );
      const workflow = yield* Effect.try({
        try: () => parseYaml(source),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WorkflowSchema)));
      const registryLogins = Object.values(workflow.jobs).flatMap(({ steps }) =>
        steps.filter(
          ({ uses }) =>
            uses ===
            "docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0",
        )
      );

      assert.lengthOf(registryLogins, 2);
      assert.deepStrictEqual(
        registryLogins.map((step) => step.with?.password),
        ["${{ secrets.GITHUB_TOKEN }}", "${{ secrets.GITHUB_TOKEN }}"],
      );
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("renders scoped and dedicated-cluster manifests from one immutable image", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const outputDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-release-",
      });
      const release = yield* renderRelease({
        image,
        outputDirectory,
        version: "0.1.0",
      });

      assert.deepStrictEqual(release, {
        image,
        manifests: {
          clusterAdmin: "agentos-firstmate-cluster-admin.yaml",
          database: "agentos-postgres.yaml",
          scoped: "agentos-firstmate.yaml",
        },
        version: "0.1.0",
      });

      const scopedManifest = yield* fileSystem.readFileString(
        paths.join(outputDirectory, release.manifests.scoped),
      );
      const clusterAdminManifest = yield* fileSystem.readFileString(
        paths.join(outputDirectory, release.manifests.clusterAdmin),
      );
      const databaseManifest = yield* fileSystem.readFileString(
        paths.join(outputDirectory, release.manifests.database),
      );
      const scoped = yield* parseResources(scopedManifest);
      const clusterAdmin = yield* parseResources(clusterAdminManifest);
      const database = yield* parseResources(databaseManifest);

      for (const manifest of [scopedManifest, clusterAdminManifest, databaseManifest]) {
        assert.match(manifest, /^apiVersion: [^\n]+\nkind: [^\n]+\n/);
        assert.notMatch(manifest, /^\{.*\}$/m);
      }
      assert.deepStrictEqual((yield* fileSystem.readDirectory(outputDirectory)).sort(), [
        "agentos-firstmate-cluster-admin.yaml",
        "agentos-firstmate.yaml",
        "agentos-postgres.yaml",
      ]);

      assert.isFalse(scoped.some(({ kind }) => kind === "ClusterRoleBinding"));
      assert.isTrue(clusterAdmin.some(({ kind }) => kind === "ClusterRoleBinding"));
      for (const resources of [scoped, clusterAdmin]) {
        const statefulSet = resources.find(isFirstMateStatefulSet);
        const containers = yield* Effect.fromNullishOr(statefulSet).pipe(
          Effect.map((resource) => [
            ...resource.spec.template.spec.initContainers,
            ...resource.spec.template.spec.containers,
          ]),
        );
        assert.strictEqual(
          statefulSet?.metadata.labels["app.kubernetes.io/version"],
          "0.1.0",
        );
        assert.deepStrictEqual(containers.map(({ image }) => image), [
          image,
          image,
          image,
          image,
        ]);
        assert.deepStrictEqual(
          containers.map(({ imagePullPolicy }) => imagePullPolicy),
          ["IfNotPresent", "IfNotPresent", "IfNotPresent", "IfNotPresent"],
        );
      }
      assert.deepStrictEqual(database, [
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
            backup: {
              target: "prefer-standby",
              volumeSnapshot: {
                online: true,
                onlineConfiguration: {
                  immediateCheckpoint: false,
                  waitForArchive: false,
                },
                snapshotOwnerReference: "backup",
              },
            },
            bootstrap: {
              initdb: {
                dataChecksums: true,
                database: "agentos",
                owner: "agentos",
              },
            },
            enableSuperuserAccess: false,
            instances: 3,
            monitoring: { enablePodMonitor: false },
            postgresql: {
              parameters: {
                max_connections: "200",
                shared_buffers: "256MB",
              },
            },
            primaryUpdateStrategy: "unsupervised",
            storage: { size: "20Gi" },
            walStorage: { size: "5Gi" },
          },
        },
      ] satisfies ReadonlyArray<Resource>);
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("rejects a mutable release image in the typed channel", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const outputDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-release-invalid-",
      });
      const failure = yield* renderRelease({
        image: "ghcr.io/akua-dev/agentos:latest",
        outputDirectory,
        version: "0.1.0",
      }).pipe(Effect.flip);

      assert.strictEqual(failure.code, "invalid_image");
      assert.include(failure.message, "immutable sha256 digest");
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("reports CLI usage through the outer Effect runtime", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("../../..", import.meta.url));
      const result = yield* run(
        "bun",
        [paths.join(root, "release", "kubernetes", "render.ts")],
        root,
      );

      assert.strictEqual(result.exitCode, 2);
      assert.strictEqual(result.stdout, "");
      assert.include(result.stderr, "Usage: render.ts");
    }).pipe(Effect.provide(BunServices.layer)));
});
