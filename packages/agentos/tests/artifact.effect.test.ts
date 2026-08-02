import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Result,
  Schema,
} from "effect";
import { parse as parseTomlSource } from "toml";

import { renderKustomize } from "../../../tooling/testing/kubernetes.ts";
import { AgentOSPackageManifest } from "./manifest-contract.ts";
import { piCommandNames } from "./pi-rpc-test.ts";
import { runTestProcess } from "./test-process.ts";

const repositoryUrl = new URL("../../../", import.meta.url);
const MiseTasks = Schema.Struct({
  tasks: Schema.Record(
    Schema.String,
    Schema.Struct({ file: Schema.String }),
  ),
});
const ReplacementManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.String,
  keywords: Schema.Array(Schema.String),
  pi: Schema.Struct({
    extensions: Schema.Array(Schema.String),
    skills: Schema.Array(Schema.String),
  }),
  dependencies: Schema.Record(Schema.String, Schema.String),
  peerDependencies: Schema.Record(Schema.String, Schema.String),
});
const InstallationManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  workspaces: Schema.Array(Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String),
  overrides: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.Record(Schema.String, Schema.String),
});

export class ArtifactTestError extends Schema.TaggedErrorClass<ArtifactTestError>()(
  "ArtifactTestError",
  {
    operation: Schema.Literals(["build", "pack", "fixture", "toml"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  },
) {}

function artifactError(
  operation: typeof ArtifactTestError.fields.operation.Type,
  detail: string,
  exitCode?: number,
) {
  return ArtifactTestError.make({ operation, detail, exitCode });
}

const parseToml = Effect.fn("test.artifact.parseToml")((source: string) =>
  Effect.try({
    try: () => parseTomlSource(source),
    catch: () => artifactError("toml", "installed mise.toml is invalid"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MiseTasks))));

const pack = Effect.fn("test.artifact.pack")(function*(
  packageDirectory: string,
  destination: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const buildDirectory = paths.join(destination, "build", "dist");
  const isolatedPackage = paths.join(destination, "package");
  yield* Effect.all([
    fileSystem.makeDirectory(buildDirectory, { recursive: true }),
    fileSystem.makeDirectory(isolatedPackage, { recursive: true }),
  ], { concurrency: "unbounded" });
  yield* Effect.forEach(
    [
      ".npmignore",
      "README.md",
      "extensions",
      "package.json",
      "resources",
      "runtime",
      "skills",
    ],
    (entry) => fileSystem.copy(
      paths.join(packageDirectory, entry),
      paths.join(isolatedPackage, entry),
    ),
    { concurrency: "unbounded" },
  );
  const compile = yield* runTestProcess(
    paths.join(packageDirectory, "node_modules", ".bin", "tsc"),
    [
      "--project",
      paths.join(packageDirectory, "tsconfig.build.json"),
      "--outDir",
      buildDirectory,
    ],
    { cwd: packageDirectory },
  );
  if (compile.exitCode !== 0) {
    return yield* artifactError(
      "build",
      "AgentOS package compilation failed; compiler output is redacted",
      compile.exitCode,
    );
  }
  yield* fileSystem.copy(buildDirectory, paths.join(isolatedPackage, "dist"));
  const packed = yield* runTestProcess(
    "bun",
    [
      "pm",
      "pack",
      "--destination",
      destination,
      "--ignore-scripts",
      "--quiet",
    ],
    { cwd: isolatedPackage },
  );
  if (packed.exitCode !== 0) {
    return yield* artifactError(
      "pack",
      "AgentOS package packing failed; process output is redacted",
      packed.exitCode,
    );
  }
  const tarball = packed.stdout.trim().split("\n").at(-1);
  if (tarball === undefined || tarball.length === 0) {
    return yield* artifactError("pack", "AgentOS pack returned no tarball");
  }
  return tarball;
});

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

describe("publishable AgentOS Pi artifacts", () => {
  it.effect("packs, installs, typechecks, and loads without the source worktree", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const repository = yield* paths.fromFileUrl(repositoryUrl);
      const agentosPackage = paths.join(repository, "packages", "agentos");
      const extensionFixture = paths.join(
        agentosPackage,
        "tests",
        "fixtures",
        "external-extension",
      );
      const replacementFixture = paths.join(
        agentosPackage,
        "tests",
        "fixtures",
        "replacement-package",
      );
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-artifacts-",
      });
      const artifacts = paths.join(sandbox, "artifacts");
      const installation = paths.join(sandbox, "installation");
      const extensionAuthor = paths.join(installation, "extension-author");
      const replacement = paths.join(installation, "replacement");
      yield* Effect.all([
        fileSystem.makeDirectory(artifacts, { recursive: true }),
        fileSystem.makeDirectory(extensionAuthor, { recursive: true }),
        fileSystem.copy(replacementFixture, replacement),
      ], { concurrency: "unbounded" });

      const agentosTarball = yield* pack(agentosPackage, artifacts);
      yield* Effect.all([
        fileSystem.copyFile(
          paths.join(extensionFixture, "index.ts"),
          paths.join(extensionAuthor, "index.ts"),
        ),
        fileSystem.copyFile(
          paths.join(extensionFixture, "package.json"),
          paths.join(extensionAuthor, "package.json"),
        ),
        fileSystem.copyFile(
          paths.join(extensionFixture, "tsconfig.json"),
          paths.join(extensionAuthor, "tsconfig.json"),
        ),
      ], { concurrency: "unbounded" });
      const replacementManifest = yield* Schema.encodeEffect(
        Schema.fromJsonString(ReplacementManifest),
      )({
        name: "@example/agentos-replacement",
        version: "1.0.0",
        private: true,
        type: "module",
        keywords: ["pi-package"],
        pi: {
          extensions: ["./extensions/replacement.ts"],
          skills: ["./skills"],
        },
        dependencies: {
          "@akua-dev/agentos": `file:${agentosTarball}`,
        },
        peerDependencies: {
          "@earendil-works/pi-ai": "0.81.1",
          "@earendil-works/pi-coding-agent": "0.81.1",
        },
      });
      yield* fileSystem.writeFileString(
        paths.join(replacement, "package.json"),
        `${replacementManifest}\n`,
      );
      const installationManifest = yield* Schema.encodeEffect(
        Schema.fromJsonString(InstallationManifest),
      )({
        name: "agentos-artifact-fixture",
        private: true,
        workspaces: ["extension-author", "replacement"],
        dependencies: {
          "@akua-dev/agentos": `file:${agentosTarball}`,
          "@earendil-works/pi-ai": "0.81.1",
          "@earendil-works/pi-coding-agent": "0.81.1",
        },
        overrides: {
          "@akua-dev/agentos": `file:${agentosTarball}`,
        },
        devDependencies: {
          "@types/bun": "1.3.14",
          typescript: "7.0.2",
        },
      });
      yield* fileSystem.writeFileString(
        paths.join(installation, "package.json"),
        `${installationManifest}\n`,
      );

      const install = yield* runTestProcess(
        "bun",
        ["install", "--ignore-scripts", "--no-progress"],
        { cwd: installation },
      );
      assert.strictEqual(install.exitCode, 0);
      assert.notInclude(install.stderr, "error:");
      const compile = yield* runTestProcess(
        paths.join(installation, "node_modules", ".bin", "tsc"),
        ["--project", paths.join(extensionAuthor, "tsconfig.json")],
        { cwd: installation },
      );
      assert.deepStrictEqual(compile, { exitCode: 0, stderr: "", stdout: "" });

      const installedAgentOS = paths.join(
        installation,
        "node_modules",
        "@akua-dev",
        "agentos",
      );
      const manifest = yield* fileSystem.readFileString(
        paths.join(installedAgentOS, "package.json"),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(
        Schema.fromJsonString(AgentOSPackageManifest),
      )));
      assert.strictEqual(manifest.name, "@akua-dev/agentos");
      assert.deepStrictEqual(manifest.exports, {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      });
      assert.deepStrictEqual(manifest.pi, {
        extensions: ["./extensions/agentos.ts"],
        skills: ["./skills"],
      });
      assert.deepStrictEqual(manifest.dependencies, {
        "@effect/platform-bun": "4.0.0-beta.102",
        "@opentelemetry/api": "1.9.1",
        "@opentelemetry/exporter-metrics-otlp-http": "0.221.0",
        "@opentelemetry/exporter-trace-otlp-http": "0.221.0",
        "@opentelemetry/sdk-metrics": "2.10.0",
        "@opentelemetry/sdk-node": "0.221.0",
        effect: "4.0.0-beta.102",
        yaml: "2.9.0",
        zod: "4.4.3",
      });

      const requiredFiles = [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/roles/firstmate.js",
        "dist/roles/secondmate.js",
        "extensions/agentos.ts",
        "extensions/agentos-observability.ts",
        "runtime/create-image-seed.ts",
        "runtime/pi-provider.ts",
        "skills/agentos-customization/SKILL.md",
        "skills/agentos-observability/SKILL.md",
        "skills/agentos-observability/agents/openai.yaml",
        "skills/agentos-observability/references/control-matrix.md",
        "skills/agentos-observability/references/dashboards.md",
        "skills/agentos-observability/references/alerts.md",
        "skills/agentos-observability/references/runbooks.md",
        "skills/agentos-upgrade/SKILL.md",
        "skills/agentos-upgrade/agents/openai.yaml",
        "skills/agentos-upgrade/references/database.md",
        "skills/agentos-upgrade/references/one-mate.md",
        "skills/agentos-upgrade/references/fleet.md",
        "resources/roles/firstmate/instructions.md",
        "resources/roles/firstmate/mise.toml",
        "resources/roles/firstmate/kubernetes/base/kustomization.yaml",
        "resources/crewmates/default/BRIEF.md",
        "resources/crewmates/default/images/artifact-fs/Dockerfile",
      ];
      for (const file of requiredFiles) {
        assert.isTrue(yield* fileSystem.exists(paths.join(installedAgentOS, file)));
      }
      for (const absent of [
        "prompts",
        "dist/runtime.js",
        "dist/roles/shared.js",
        "resources/roles/firstmate/kubernetes/tests",
      ]) {
        assert.isFalse(yield* fileSystem.exists(paths.join(installedAgentOS, absent)));
      }

      const nativeResourceRoots = [
        "resources/roles/firstmate",
        "resources/roles/secondmate",
        "resources/crewmates/default",
      ].map((relative) => paths.join(installedAgentOS, relative));
      for (const resourceRoot of nativeResourceRoots) {
        const mise = yield* fileSystem.readFileString(
          paths.join(resourceRoot, "mise.toml"),
        ).pipe(Effect.flatMap(parseToml));
        for (const task of Object.values(mise.tasks)) {
          assert.isTrue(
            yield* fileSystem.exists(paths.resolve(resourceRoot, task.file)),
          );
        }
      }

      for (const kubernetesRoot of [
        "resources/roles/firstmate/kubernetes/base",
        "resources/roles/secondmate/kubernetes/base",
        "resources/crewmates/default/kubernetes/base",
      ]) {
        const rendered = yield* renderKustomize(
          paths.join(installedAgentOS, kubernetesRoot),
        );
        assert.isAbove(rendered.length, 0);
      }

      const firstMateCommands = yield* piCommandNames({
        agentDirectory: paths.join(sandbox, "pi-agent"),
        cwd: paths.join(installedAgentOS, "resources", "roles", "firstmate"),
        role: "first_mate",
      });
      for (const command of [
        "background-commands",
        "memory",
        "skill:agentos-supervision",
        "skill:agentos-observability",
        "skill:agentos-bootstrap",
        "skill:agentos-upgrade",
      ]) {
        assert.include(firstMateCommands, command);
      }
      const secondMateCommands = yield* piCommandNames({
        agentDirectory: paths.join(sandbox, "second-mate-pi-agent"),
        cwd: paths.join(installedAgentOS, "resources", "roles", "secondmate"),
        role: "second_mate",
      });
      for (const command of [
        "background-commands",
        "memory",
        "skill:agentos-supervision",
        "skill:agentos-observability",
        "skill:agentos-upgrade",
      ]) {
        assert.include(secondMateCommands, command);
      }
      assert.notInclude(secondMateCommands, "skill:agentos-bootstrap");

      const replacementProject = paths.join(sandbox, "replacement-project");
      yield* fileSystem.makeDirectory(replacementProject, { recursive: true });
      const replacementCommands = yield* piCommandNames({
        agentDirectory: paths.join(sandbox, "replacement-pi-agent"),
        cwd: replacementProject,
        packages: [replacement],
        role: "first_mate",
      });
      assert.include(replacementCommands, "example-ecosystem-status");
      assert.include(replacementCommands, "skill:example-replacement");
      for (const absent of [
        "background-commands",
        "memory",
        "skill:agentos-supervision",
      ]) {
        assert.notInclude(replacementCommands, absent);
      }

      yield* fileSystem.remove(
        paths.join(
          installedAgentOS,
          "resources",
          "roles",
          "firstmate",
          "skills",
        ),
        { recursive: true },
      );
      const incomplete = yield* Effect.result(piCommandNames({
        agentDirectory: paths.join(sandbox, "incomplete-pi-agent"),
        cwd: paths.join(installedAgentOS, "resources", "roles", "firstmate"),
        role: "first_mate",
      }));
      assert.isTrue(
        Result.isFailure(incomplete) ||
          !incomplete.success.includes("background-commands"),
      );
    }).pipe(Effect.provide(platform))),
    120_000,
  );
});
