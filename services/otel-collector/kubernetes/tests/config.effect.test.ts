import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { parseDocument } from "yaml";

import {
  AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
  AGENTOS_TELEMETRY_EVENT_DEFINITIONS,
  AGENTOS_TELEMETRY_FORBIDDEN_ATTRIBUTE_KEYS,
  AGENTOS_TELEMETRY_METRIC_DEFINITIONS,
  AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS,
} from "../../../../packages/agentos/src/telemetry/contract.ts";
import { renderKustomize } from "../../../../tooling/testing/kubernetes.ts";

const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);
const CollectorStatefulSet = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.Struct({
    template: Schema.Struct({
      spec: Schema.Struct({
        containers: Schema.Array(Schema.Struct({
          name: Schema.String,
          env: Schema.Array(Schema.Struct({
            name: Schema.String,
            value: Schema.optional(Schema.String),
          })),
        })),
      }),
    }),
  }),
});
const Action = Schema.Struct({
  key: Schema.String,
  action: Schema.String,
});
const StatementGroup = Schema.Struct({
  statements: Schema.Array(Schema.String),
});
const CollectorConfig = Schema.Struct({
  processors: Schema.Record(Schema.String, Schema.Struct({
    actions: Schema.optional(Schema.Array(Action)),
    attributes: Schema.optional(Schema.Array(Action)),
    detectors: Schema.optional(Schema.Array(Schema.String)),
    extract: Schema.optional(Schema.Unknown),
    timeout: Schema.optional(Schema.String),
    override: Schema.optional(Schema.Boolean),
    mode: Schema.optional(Schema.String),
    sampling_percentage: Schema.optional(Schema.String),
    fail_closed: Schema.optional(Schema.Boolean),
    sampling_precision: Schema.optional(Schema.Number),
    trace_statements: Schema.optional(Schema.Array(StatementGroup)),
    metric_statements: Schema.optional(Schema.Array(StatementGroup)),
    log_statements: Schema.optional(Schema.Array(StatementGroup)),
  })),
  service: Schema.Struct({
    pipelines: Schema.Record(Schema.String, Schema.Struct({
      processors: Schema.Array(Schema.String),
      exporters: Schema.Array(Schema.String),
    })),
  }),
  extensions: Schema.Struct({
    "file_storage/queue": Schema.Struct({
      directory: Schema.String,
      timeout: Schema.String,
      max_size: Schema.Number,
      fsync: Schema.Boolean,
      recreate: Schema.Boolean,
      compaction: Schema.Struct({
        on_start: Schema.Boolean,
        on_rebound: Schema.Boolean,
        cleanup_on_start: Schema.Boolean,
        directory: Schema.String,
        rebound_needed_threshold_mib: Schema.Number,
        rebound_trigger_threshold_mib: Schema.Number,
        check_interval: Schema.String,
      }),
    }),
  }),
  receivers: Schema.Struct({
    otlp: Schema.Struct({
      protocols: Schema.Struct({
        grpc: Schema.Struct({
          endpoint: Schema.String,
          max_recv_msg_size_mib: Schema.Number,
        }),
        http: Schema.Struct({
          endpoint: Schema.String,
          max_request_body_size: Schema.Number,
          read_timeout: Schema.String,
          read_header_timeout: Schema.String,
        }),
      }),
    }),
  }),
});

const ResourceDetection = Schema.Struct({
  detectors: Schema.Array(Schema.String),
  timeout: Schema.String,
  override: Schema.Boolean,
});
const ProbabilisticSampler = Schema.Struct({
  mode: Schema.String,
  sampling_percentage: Schema.String,
  fail_closed: Schema.Boolean,
  sampling_precision: Schema.Number,
});
const KubernetesAttributes = Schema.Struct({
  extract: Schema.Struct({
    labels: Schema.Array(Schema.Struct({
      tag_name: Schema.String,
      key: Schema.String,
      from: Schema.String,
    })),
  }),
});
const RemoteExporter = Schema.Struct({
  retry_on_failure: Schema.Struct({
    enabled: Schema.Boolean,
    initial_interval: Schema.String,
    max_interval: Schema.String,
    max_elapsed_time: Schema.String,
  }),
  sending_queue: Schema.Struct({
    enabled: Schema.Boolean,
    num_consumers: Schema.Number,
    sizer: Schema.String,
    queue_size: Schema.Number,
    wait_for_result: Schema.Boolean,
    block_on_overflow: Schema.Boolean,
    storage: Schema.String,
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

const kubernetesUrl = new URL("..", import.meta.url);
const collectorImage =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";

const renderConfig = Effect.fn("test.otelConfig.render")(function*(
  relativeDirectory: string,
) {
  const paths = yield* Path.Path;
  const kubernetesDirectory = yield* paths.fromFileUrl(kubernetesUrl);
  const documents = yield* renderKustomize(
    paths.join(kubernetesDirectory, relativeDirectory),
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

type ExportMode = "base" | "http" | "grpc";

const validate = Effect.fn("test.otelConfig.validate")(function*(
  config: string,
  mode: ExportMode,
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
      `  ${mode === "grpc" ? "otlp_grpc" : "otlp_http"}/remote:`,
      "    headers:",
      '      authorization: "redacted-test-value"',
      "",
    ].join("\n")).pipe(
      Effect.mapError(() => testError("fixture", "header fixture write failed")),
    );
    const configArguments = [
      "--config=file:/etc/otelcol/collector.yaml",
      ...(mode === "base" ? [] : [
        "--config=file:/etc/otelcol-secret/headers.yaml",
      ]),
    ];
    return yield* run("docker", [
      "run",
      "--pull=never",
      "--rm",
      "-e",
      "K8S_NODE_NAME=test-node",
      "-e",
      `OTEL_EXPORTER_OTLP_ENDPOINT=${
        mode === "grpc" ? "otel.example.test:4317" : "https://otel.example.test"
      }`,
      "-e",
      "OTEL_RESOURCE_ATTRIBUTES=agentos.fleet.name=test",
      "-e",
      "AGENTOS_OTEL_TRACE_SAMPLING_PERCENTAGE=100",
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

function contractAttributesFor(signal: "resource" | "span") {
  return Object.values(AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS)
    .filter((definition) => definition.signals.includes(signal))
    .map(({ name }) => name)
    .sort();
}

function metricAttributes() {
  return Array.from(new Set(
    Object.values(AGENTOS_TELEMETRY_METRIC_DEFINITIONS)
      .flatMap(({ labels }) => labels),
  )).sort();
}

function eventAttributes() {
  return Array.from(new Set(
    Object.values(AGENTOS_TELEMETRY_EVENT_DEFINITIONS)
      .flatMap(({ attributes }) => attributes),
  )).sort();
}

function keepKeys(target: string, keys: ReadonlyArray<string>) {
  return `keep_keys(${target}, [${keys.map((key) => JSON.stringify(key)).join(", ")}])`;
}

function assertKeepKeys(
  actual: string | undefined,
  target: string,
  keys: ReadonlyArray<string>,
) {
  assert.strictEqual(
    actual?.replace(/\s+/g, " "),
    keepKeys(target, keys),
  );
}

const validationCases: ReadonlyArray<readonly [string, ExportMode]> = [
    ["base", "base"],
    ["overlays/remote", "http"],
    ["overlays/remote-grpc", "grpc"],
    ["overlays/local-diagnostics", "http"],
];

layer(testLayer, { timeout: "60 seconds" })("Collector configuration", (it) => {
  it.effect("declares the bounded Fleet and cluster identity used to enrich native runtimes", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const kubernetesDirectory = yield* paths.fromFileUrl(kubernetesUrl);
      const documents = yield* renderKustomize(
        paths.join(kubernetesDirectory, "base"),
      );
      const resources = yield* Schema.decodeUnknownEffect(Resources)(documents);
      const statefulSet = resources.find((resource) =>
        resource.kind === "StatefulSet" &&
        resource.metadata.name === "agentos-otel-collector"
      );
      const decoded = yield* Schema.decodeUnknownEffect(CollectorStatefulSet)(
        statefulSet,
      );
      const collector = decoded.spec.template.spec.containers.find(
        ({ name }) => name === "collector",
      );
      const environment = Object.fromEntries(
        collector?.env.map(({ name, value }) => [name, value]) ?? [],
      );
      assert.strictEqual(
        environment.OTEL_RESOURCE_ATTRIBUTES,
        "agentos.fleet.name=default,deployment.environment.name=development,agentos.telemetry.contract.version=1,k8s.cluster.name=agentos",
      );
    }));

  for (const [directory, mode] of validationCases) {
    it.effect(`validates the ${directory} pipeline with Collector 0.157.0`, () =>
      Effect.gen(function*() {
        const config = yield* renderConfig(directory);
        assert.deepStrictEqual(
          yield* validate(config, mode),
          { exitCode: 0, stderr: "", stdout: "" },
        );
      }), { timeout: 60_000 });
  }

  it.effect("applies the contract privacy boundary to every signal and overlay", () =>
    Effect.gen(function*() {
      for (const directory of [
        "base",
        "overlays/remote",
        "overlays/remote-grpc",
        "overlays/local-diagnostics",
      ]) {
        const config = yield* renderConfig(directory);
        const parsed = yield* Effect.try({
          try: () => parseDocument(config).toJSON(),
          catch: () => testError("yaml", "Collector config is invalid YAML"),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollectorConfig)));
        for (const signal of ["traces", "logs"]) {
          const expected = [
            "memory_limiter",
            "k8sattributes",
            "resource_detection/fleet",
            "transform/codex_native",
            "resource/privacy",
            "attributes/privacy",
            "transform/contract_allowlist",
          ];
          if (signal === "traces") {
            expected.push("probabilistic_sampler/fleet");
          }
          expected.push("batch");
          assert.deepStrictEqual(
            parsed.service.pipelines[signal]?.processors,
            expected,
          );
        }
        assert.deepStrictEqual(parsed.service.pipelines.metrics?.processors, [
          "memory_limiter",
          "k8sattributes",
          "resource_detection/fleet",
          "transform/codex_native",
          "resource/privacy",
          "attributes/privacy",
          "attributes/metric_cardinality",
          "transform/contract_allowlist",
          "batch",
        ]);
        const spanPrivacy = parsed.processors["attributes/privacy"];
        const resourcePrivacy = parsed.processors["resource/privacy"];
        const metricCardinality =
          parsed.processors["attributes/metric_cardinality"];
        assert.isDefined(spanPrivacy);
        assert.isDefined(resourcePrivacy);
        assert.isDefined(metricCardinality);
        const traceStatements =
          parsed.processors["transform/contract_allowlist"]
            ?.trace_statements;
        assert.lengthOf(traceStatements ?? [], 4);
        assertKeepKeys(
          traceStatements?.[0]?.statements[0],
          "resource.attributes",
          contractAttributesFor("resource"),
        );
        assert.strictEqual(
          traceStatements?.[1]?.statements[0],
          'delete_matching_keys(scope.attributes, ".*")',
        );
        assertKeepKeys(
          traceStatements?.[2]?.statements[0],
          "span.attributes",
          contractAttributesFor("span"),
        );
        assert.strictEqual(
          traceStatements?.[3]?.statements[0],
          'delete_matching_keys(spanevent.attributes, ".*")',
        );

        const metricStatements =
          parsed.processors["transform/contract_allowlist"]
            ?.metric_statements;
        assert.lengthOf(metricStatements ?? [], 4);
        assertKeepKeys(
          metricStatements?.[0]?.statements[0],
          "resource.attributes",
          contractAttributesFor("resource"),
        );
        assert.strictEqual(
          metricStatements?.[1]?.statements[0],
          'delete_matching_keys(scope.attributes, ".*")',
        );
        assertKeepKeys(
          metricStatements?.[2]?.statements[0],
          "datapoint.attributes",
          metricAttributes(),
        );
        assert.strictEqual(
          metricStatements?.[3]?.statements[0],
          'delete_matching_keys(exemplar.filtered_attributes, ".*")',
        );

        const logStatements =
          parsed.processors["transform/contract_allowlist"]?.log_statements;
        assert.lengthOf(logStatements ?? [], 4);
        assertKeepKeys(
          logStatements?.[0]?.statements[0],
          "resource.attributes",
          contractAttributesFor("resource"),
        );
        assert.strictEqual(
          logStatements?.[1]?.statements[0],
          'delete_matching_keys(scope.attributes, ".*")',
        );
        assertKeepKeys(
          logStatements?.[2]?.statements[0],
          "log.attributes",
          eventAttributes(),
        );
        assert.strictEqual(
          logStatements?.[3]?.statements[0],
          'set(log.body, "")',
        );
        const spanForbidden = new Set(
          spanPrivacy?.actions?.map(({ key }) => key) ?? [],
        );
        const resourceForbidden = new Set(
          resourcePrivacy?.attributes?.map(({ key }) => key) ?? [],
        );
        for (const key of AGENTOS_TELEMETRY_FORBIDDEN_ATTRIBUTE_KEYS) {
          assert.isTrue(
            spanForbidden.has(key),
            `${directory} span privacy: ${key}`,
          );
          assert.isTrue(
            resourceForbidden.has(key),
            `${directory} resource privacy: ${key}`,
          );
        }
        const metricProtected = new Set(
          metricCardinality?.actions?.map(({ key }) => key) ?? [],
        );
        for (const key of AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS) {
          assert.isTrue(
            metricProtected.has(key),
            `${directory} metric cardinality: ${key}`,
          );
        }

        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(KubernetesAttributes)(
            parsed.processors.k8sattributes,
          ),
          {
            extract: {
              labels: [
                {
                  tag_name: "agentos.ai.runtime",
                  key: "agentos.akua.dev/ai-runtime",
                  from: "pod",
                },
                {
                  tag_name: "agentos.ai.runtime.version",
                  key: "agentos.akua.dev/ai-runtime-version",
                  from: "pod",
                },
              ],
            },
          },
        );
        const codexNative = parsed.processors["transform/codex_native"];
        assert.isDefined(codexNative, `${directory} Codex normalization`);
        for (const statements of [
          codexNative?.trace_statements,
          codexNative?.metric_statements,
          codexNative?.log_statements,
        ]) {
          assert.isTrue(
            (statements?.flatMap(({ statements }) => statements) ?? []).some(
              (statement) => statement.includes('resource.attributes["k8s.workload.name"]'),
            ),
            `${directory} workload enrichment`,
          );
        }
        const nativeLogStatements = codexNative?.log_statements
          ?.flatMap(({ statements }) => statements) ?? [];
        for (const attribute of [
          "agentos.ai.status_class",
          "agentos.ai.error.class",
          "agentos.ai.provider.request_id",
          "agentos.ai.request.kind",
        ]) {
          assert.isTrue(
            nativeLogStatements.some((statement) => statement.includes(attribute)),
            `${directory} Codex log projection: ${attribute}`,
          );
        }
      }
    }));

  it.effect("bounds receiver, queue storage, retries, sampling, and resource detection", () =>
    Effect.gen(function*() {
      for (const directory of [
        "base",
        "overlays/remote",
        "overlays/remote-grpc",
        "overlays/local-diagnostics",
      ]) {
        const source = yield* renderConfig(directory);
        const parsed = yield* Effect.try({
          try: () => parseDocument(source).toJSON(),
          catch: () => testError("yaml", "Collector config is invalid YAML"),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollectorConfig)));
        assert.deepStrictEqual(parsed.receivers.otlp.protocols, {
          grpc: { endpoint: "0.0.0.0:4317", max_recv_msg_size_mib: 8 },
          http: {
            endpoint: "0.0.0.0:4318",
            max_request_body_size: 8_388_608,
            read_timeout: "10s",
            read_header_timeout: "5s",
          },
        });
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(ResourceDetection)(
            parsed.processors["resource_detection/fleet"],
          ),
          { detectors: ["env"], timeout: "2s", override: false },
        );
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(ProbabilisticSampler)(
            parsed.processors["probabilistic_sampler/fleet"],
          ),
          {
            mode: "proportional",
            sampling_percentage:
              "${env:AGENTOS_OTEL_TRACE_SAMPLING_PERCENTAGE}",
            fail_closed: true,
            sampling_precision: 4,
          },
        );
        assert.deepStrictEqual(parsed.extensions["file_storage/queue"], {
          directory: "/var/lib/otelcol/storage",
          timeout: "1s",
          max_size: 536_870_912,
          fsync: true,
          recreate: true,
          compaction: {
            on_start: true,
            on_rebound: true,
            cleanup_on_start: true,
            directory: "/var/lib/otelcol/storage",
            rebound_needed_threshold_mib: 256,
            rebound_trigger_threshold_mib: 64,
            check_interval: "5s",
          },
        });
        if (directory === "base") continue;
        const exporterName = directory === "overlays/remote-grpc"
          ? "otlp_grpc/remote"
          : "otlp_http/remote";
        const document = parseDocument(source).toJSON();
        const exporters = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ exporters: Schema.Record(Schema.String, Schema.Unknown) }),
        )(document);
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(RemoteExporter)(
            exporters.exporters[exporterName],
          ),
          {
            retry_on_failure: {
              enabled: true,
              initial_interval: "1s",
              max_interval: "30s",
              max_elapsed_time: "0s",
            },
            sending_queue: {
              enabled: true,
              num_consumers: 4,
              sizer: "requests",
              queue_size: 2048,
              wait_for_result: false,
              block_on_overflow: false,
              storage: "file_storage/queue",
            },
          },
        );
      }
    }));
});
