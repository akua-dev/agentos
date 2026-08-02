import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { renderKustomize } from "../../../../tooling/testing/kubernetes.ts";

const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Resources = Schema.Array(Resource);
const Action = Schema.Struct({
  key: Schema.String,
  action: Schema.String,
});
const CollectorConfig = Schema.Struct({
  processors: Schema.Record(Schema.String, Schema.Struct({
    actions: Schema.optional(Schema.Array(Action)),
    attributes: Schema.optional(Schema.Array(Action)),
  })),
  service: Schema.Struct({
    pipelines: Schema.Record(Schema.String, Schema.Struct({
      processors: Schema.Array(Schema.String),
      exporters: Schema.Array(Schema.String),
    })),
  }),
});

class CollectorConfigTestError extends Schema.TaggedErrorClass<CollectorConfigTestError>()(
  "CollectorConfigTestError",
  {
    operation: Schema.Literals(["fixture", "process", "yaml"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  },
) {}

function testError(
  operation: typeof CollectorConfigTestError.fields.operation.Type,
  detail: string,
  exitCode?: number,
) {
  return CollectorConfigTestError.make({ operation, detail, exitCode });
}

const run = Effect.fn("test.otelConfig.run")(function*(
  executable: string,
  args: ReadonlyArray<string>,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(args), {
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
    Effect.mapError(() => testError("process", `${executable} failed to start`)),
  );
});

const kubernetesDirectory = fileURLToPath(new URL("..", import.meta.url));
const collectorImage =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";

const renderConfig = Effect.fn("test.otelConfig.render")(function*(
  relativeDirectory: string,
) {
  const documents = yield* renderKustomize(
    join(kubernetesDirectory, relativeDirectory),
  );
  const resources = yield* Schema.decodeUnknownEffect(Resources)(documents);
  const config = resources.find((resource) =>
    resource.kind === "ConfigMap" &&
    resource.metadata.name === "agentos-otel-collector"
  )?.data?.["collector.yaml"];
  if (config === undefined) {
    return yield* testError("fixture", "Rendered Collector config is missing");
  }
  return config;
});

const validate = Effect.fn("test.otelConfig.validate")(function*(
  config: string,
  remote: boolean,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-otel-config-",
    });
    const configPath = paths.join(directory, "collector.yaml");
    const headersPath = paths.join(directory, "headers.yaml");
    yield* fileSystem.writeFileString(configPath, config).pipe(
      Effect.mapError(() => testError("fixture", "Collector config write failed")),
    );
    yield* fileSystem.writeFileString(headersPath, [
      "exporters:",
      "  otlp_http/remote:",
      "    headers:",
      '      authorization: "redacted-test-value"',
      "",
    ].join("\n")).pipe(
      Effect.mapError(() => testError("fixture", "header fixture write failed")),
    );
    const configArguments = [
      "--config=file:/etc/otelcol/collector.yaml",
      ...(remote ? ["--config=file:/etc/otelcol-secret/headers.yaml"] : []),
    ];
    return yield* run("docker", [
      "run",
      "--pull=never",
      "--rm",
      "-e",
      "K8S_NODE_NAME=test-node",
      "-e",
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test",
      "-v",
      `${configPath}:/etc/otelcol/collector.yaml:ro`,
      "-v",
      `${headersPath}:/etc/otelcol-secret/headers.yaml:ro`,
      collectorImage,
      "validate",
      ...configArguments,
    ]);
  }));
});

const imageReady = Layer.effectDiscard(Effect.gen(function*() {
  const result = yield* run("docker", ["pull", "--quiet", collectorImage]);
  if (result.exitCode !== 0) {
    return yield* testError(
      "process",
      "Collector image pull failed; stderr is redacted",
      result.exitCode,
    );
  }
})).pipe(Layer.provide(BunServices.layer));
const testLayer = Layer.merge(BunServices.layer, imageReady);

layer(testLayer, { timeout: "60 seconds" })("Collector configuration", (it) => {
  for (const directory of [
    "base",
    "overlays/remote",
    "overlays/local-diagnostics",
  ]) {
    it.effect(`validates the ${directory} pipeline with Collector 0.157.0`, () =>
      Effect.gen(function*() {
        const config = yield* renderConfig(directory);
        assert.deepStrictEqual(
          yield* validate(config, directory !== "base"),
          { exitCode: 0, stderr: "", stdout: "" },
        );
      }), { timeout: 60_000 });
  }

  it.effect("applies the privacy processors to every signal", () =>
    Effect.gen(function*() {
      const config = yield* renderConfig("overlays/remote");
      const parsed = yield* Effect.try({
        try: () => parseDocument(config).toJSON(),
        catch: () => testError("yaml", "Collector config is invalid YAML"),
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollectorConfig)));
      for (const signal of ["traces", "metrics", "logs"]) {
        assert.deepStrictEqual(parsed.service.pipelines[signal]?.processors, [
          "memory_limiter",
          "k8sattributes",
          "resource/privacy",
          "attributes/privacy",
          "batch",
        ]);
        assert.deepStrictEqual(parsed.service.pipelines[signal]?.exporters, [
          "otlp_http/remote",
        ]);
      }
      const spanPrivacy = parsed.processors["attributes/privacy"];
      const resourcePrivacy = parsed.processors["resource/privacy"];
      assert.isDefined(spanPrivacy);
      assert.isDefined(resourcePrivacy);
      const spanForbidden = new Set(
        spanPrivacy?.actions?.map(({ key }) => key) ?? [],
      );
      const resourceForbidden = new Set(
        resourcePrivacy?.attributes?.map(({ key }) => key) ?? [],
      );
      for (const key of spanForbidden) assert.isTrue(resourceForbidden.has(key));
    }));
});
