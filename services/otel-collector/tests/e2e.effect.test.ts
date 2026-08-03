import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  AGENTOS_TELEMETRY_EVENTS,
} from "../../../packages/agentos/src/telemetry/contract.ts";
import { allocateBunTestPort } from "../../../tooling/testing/bun-http.ts";
import { renderKustomize } from "../../../tooling/testing/kubernetes.ts";
import { acquireOtlpTestSink } from "./otlp-sink.ts";

const repositoryUrl = new URL("../../..", import.meta.url);
const image =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const TraceAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({ stringValue: Schema.String }),
});
const TracePayload = Schema.Struct({
  resourceSpans: Schema.Array(Schema.Struct({
    resource: Schema.Struct({ attributes: Schema.Array(TraceAttribute) }),
    scopeSpans: Schema.Array(Schema.Struct({
      scope: Schema.Struct({ name: Schema.String }),
      spans: Schema.Array(Schema.Struct({
        traceId: Schema.String,
        spanId: Schema.String,
        name: Schema.String,
        kind: Schema.Number,
        startTimeUnixNano: Schema.String,
        endTimeUnixNano: Schema.String,
        attributes: Schema.Array(TraceAttribute),
        status: Schema.Struct({ code: Schema.Number }),
      })),
    })),
  })),
});
const MetricPayload = Schema.Struct({
  resourceMetrics: Schema.Array(Schema.Struct({
    resource: Schema.Struct({ attributes: Schema.Array(TraceAttribute) }),
    scopeMetrics: Schema.Array(Schema.Struct({
      scope: Schema.Struct({ name: Schema.String }),
      metrics: Schema.Array(Schema.Struct({
        name: Schema.String,
        unit: Schema.String,
        gauge: Schema.Struct({
          dataPoints: Schema.Array(Schema.Struct({
            attributes: Schema.Array(TraceAttribute),
            timeUnixNano: Schema.String,
            asDouble: Schema.Number,
          })),
        }),
      })),
    })),
  })),
});
const LogPayload = Schema.Struct({
  resourceLogs: Schema.Array(Schema.Struct({
    resource: Schema.Struct({ attributes: Schema.Array(TraceAttribute) }),
    scopeLogs: Schema.Array(Schema.Struct({
      scope: Schema.Struct({ name: Schema.String }),
      logRecords: Schema.Array(Schema.Struct({
        timeUnixNano: Schema.String,
        observedTimeUnixNano: Schema.String,
        severityNumber: Schema.Number,
        severityText: Schema.String,
        traceId: Schema.String,
        spanId: Schema.String,
        eventName: Schema.String,
        body: Schema.Struct({ stringValue: Schema.String }),
        attributes: Schema.Array(TraceAttribute),
      })),
    })),
  })),
});

class OtlpE2eError extends Schema.TaggedErrorClass<OtlpE2eError>()(
  "OtlpE2eError",
  {
    operation: Schema.String,
    code: Schema.Literals([
      "command_failed",
      "http_failed",
      "missing_resource",
      "timeout",
    ]),
  },
) {}

const platform = Layer.mergeAll(
  BunServices.layer,
  BunHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

function failure(
  operation: string,
  code: OtlpE2eError["code"],
) {
  return OtlpE2eError.make({ operation, code });
}

const required = Effect.fn("test.otelE2e.required")(function*<A>(
  value: A | undefined,
  operation: string,
) {
  if (value === undefined) {
    return yield* failure(operation, "missing_resource");
  }
  return value;
});

const runCommand = Effect.fn("test.otelE2e.command")(function*(
  executable: string,
  args: ReadonlyArray<string>,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(args), {
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(Effect.mapError(() => failure(executable, "command_failed")));
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    if (exitCode !== 0) {
      return yield* failure(executable, "command_failed");
    }
    return { stderr, stdout };
  }));
});

function startCollector(options: {
  readonly configPath: string;
  readonly diagnostics?: string;
  readonly headersPath: string;
  readonly healthPort?: number;
  readonly metricsPort?: number;
  readonly name: string;
  readonly port: number;
  readonly remoteEndpoint: string;
  readonly storage: string;
  readonly storageReadOnly?: boolean;
}) {
  return ChildProcess.make("docker", [
    "run",
    "--rm",
    "--name",
    options.name,
    "-p",
    `127.0.0.1:${options.port}:4318`,
    ...(options.metricsPort === undefined ? [] : [
      "-p",
      `127.0.0.1:${options.metricsPort}:8888`,
    ]),
    ...(options.healthPort === undefined ? [] : [
      "-p",
      `127.0.0.1:${options.healthPort}:13133`,
    ]),
    "-e",
    `OTEL_EXPORTER_OTLP_ENDPOINT=${options.remoteEndpoint}`,
    "-e",
    "K8S_NODE_NAME=test-node",
    "-e",
    "AGENTOS_OTEL_TRACE_SAMPLING_PERCENTAGE=100",
    "-e",
    "OTEL_RESOURCE_ATTRIBUTES=agentos.fleet.name=test,deployment.environment.name=test,agentos.telemetry.contract.version=1",
    "-v",
    `${options.configPath}:/etc/otelcol/collector.yaml:ro`,
    "-v",
    `${options.headersPath}:/etc/otelcol-secret/headers.yaml:ro`,
    "-v",
    `${options.storage}:/var/lib/otelcol${
      options.storageReadOnly === true ? ":ro" : ""
    }`,
    ...(options.diagnostics === undefined ? [] : [
      "-v",
      `${options.diagnostics}:/var/lib/otelcol-diagnostics`,
    ]),
    image,
    "--config=file:/etc/otelcol/collector.yaml",
    "--config=file:/etc/otelcol-secret/headers.yaml",
  ], {
    forceKillAfter: "2 seconds",
    killSignal: "SIGTERM",
    stderr: "ignore",
    stdout: "ignore",
  }).pipe(Effect.mapError(() => failure("start_collector", "command_failed")));
}

function stopCollector(name: string) {
  return runCommand("docker", ["stop", "--timeout", "2", name]).pipe(
    Effect.asVoid,
  );
}

function removeCollector(name: string) {
  return runCommand("docker", ["rm", "--force", name]).pipe(Effect.asVoid);
}

const postOtlp = Effect.fn("test.otelE2e.postOtlp")(function*(
  signal: "logs" | "metrics" | "traces",
  port: number,
  body: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(
    `http://127.0.0.1:${port}/v1/${signal}`,
  ).pipe(
    HttpClientRequest.setHeader("content-type", "application/json"),
    HttpClientRequest.bodyText(body, "application/json"),
  );
  return yield* client.execute(request).pipe(
    Effect.flatMap((response) => response.text.pipe(Effect.as(response))),
    Effect.mapError(() => failure(`post_${signal}`, "http_failed")),
  );
});

function postTrace(port: number, body: string) {
  return postOtlp("traces", port, body);
}

function postMetrics(port: number, body: string) {
  return postOtlp("metrics", port, body);
}

function postLogs(port: number, body: string) {
  return postOtlp("logs", port, body);
}

const getText = Effect.fn("test.otelE2e.getText")(function*(
  url: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(url).pipe(
    Effect.mapError(() => failure("get_http", "http_failed")),
  );
  return {
    body: yield* response.text.pipe(
      Effect.mapError(() => failure("read_http", "http_failed")),
    ),
    status: response.status,
  };
});

const waitFor = Effect.fn("test.otelE2e.waitFor")(function*<R>(
  operation: string,
  check: Effect.Effect<boolean, never, R>,
) {
  yield* check.pipe(
    Effect.flatMap((ready) =>
      ready ? Effect.void : Effect.fail(failure(operation, "timeout"))
    ),
    Effect.retry(Schedule.addDelay(
      Schedule.recurs(150),
      () => Effect.succeed("100 millis"),
    )),
  );
});

function seedTrace() {
  const attribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", "agentos-e2e"),
            attribute(
              "provider.account.email",
              "provider-account@example.test",
            ),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "agentos-e2e" },
            spans: [
              {
                traceId: "00000000000000000000000000000001",
                spanId: "0000000000000001",
                name: "safe.operation",
                kind: 1,
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
                attributes: [
                  attribute("agentos.ai.runtime", "pi"),
                  attribute("custom.safe_looking", "SEED_UNKNOWN_TRACE"),
                  attribute("gen_ai.prompt", "SEED_PROMPT"),
                  attribute("authorization", "Bearer sk-seeded-secret"),
                  attribute(
                    "error.message",
                    "raw upstream private error",
                  ),
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  } satisfies typeof TracePayload.Type;
}

function seedMetric() {
  const attribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attribute("service.name", "agentos-e2e"),
            attribute("agentos.repository.name", "private-repository"),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "agentos-e2e" },
            metrics: [
              {
                name: "agentos.test.cardinality",
                unit: "{request}",
                gauge: {
                  dataPoints: [
                    {
                      attributes: [
                        attribute("agentos.ai.route", "ai_gateway"),
                        attribute(
                          "agentos.identity.agent_id",
                          "10000000-0000-4000-8000-000000000001",
                        ),
                        attribute(
                          "agentos.memory.query",
                          "SEED_PRIVATE_MEMORY_QUERY",
                        ),
                        attribute(
                          "custom.safe_looking",
                          "SEED_UNKNOWN_METRIC",
                        ),
                      ],
                      timeUnixNano: "2000000000",
                      asDouble: 1,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies typeof MetricPayload.Type;
}

function seedLog() {
  const attribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "agentos-e2e"),
            attribute("custom.resource", "SEED_UNKNOWN_RESOURCE"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "agentos-e2e" },
            logRecords: [
              {
                timeUnixNano: "2000000000",
                observedTimeUnixNano: "2000000000",
                severityNumber: 17,
                severityText: "ERROR",
                traceId: "00000000000000000000000000000001",
                spanId: "0000000000000001",
                eventName: AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
                body: { stringValue: "SEED_PRIVATE_LOG_BODY" },
                attributes: [
                  attribute("agentos.ai.runtime", "pi"),
                  attribute("agentos.ai.route", "ai_gateway"),
                  attribute("agentos.ai.status_class", "server_error"),
                  attribute("agentos.ai.error.class", "overload"),
                  attribute("custom.safe_looking", "SEED_UNKNOWN_LOG"),
                ],
              },
            ],
          },
        ],
      },
    ],
  } satisfies typeof LogPayload.Type;
}

function seedTraceBatch(count: number) {
  const source = seedTrace();
  const resource = source.resourceSpans[0]!;
  const scope = resource.scopeSpans[0]!;
  const span = scope.spans[0]!;
  return {
    resourceSpans: [{
      ...resource,
      scopeSpans: [{
        ...scope,
        spans: Array.from({ length: count }, (_, index) => ({
          ...span,
          spanId: (index + 1).toString(16).padStart(16, "0"),
        })),
      }],
    }],
  } satisfies typeof TracePayload.Type;
}

function positiveMetric(body: string, name: string): boolean {
  return body.split("\n").some((line) =>
    !line.startsWith("#") &&
    line.includes(name) &&
    Number(line.trim().split(/\s+/).at(-1)) > 0
  );
}

const liveE2eEnabled = Effect.fn("test.otelE2e.enabled")(function*() {
  const enabled = yield* Config.option(Config.string("AGENTOS_RUN_OTEL_E2E"));
  return Option.getOrUndefined(enabled) === "true";
});

const acquireCollectorFixture = Effect.fn("test.otelE2e.fixture")(function*(
  options: {
    readonly overlay: "local-diagnostics" | "remote";
    readonly transform?: (source: string) => string;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const repository = yield* paths.fromFileUrl(repositoryUrl);
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-otel-e2e-",
  });
  const storage = paths.join(directory, "storage");
  const diagnostics = paths.join(directory, "diagnostics");
  const configPath = paths.join(directory, "collector.yaml");
  const headersPath = paths.join(directory, "headers.yaml");
  yield* Effect.forEach([storage, diagnostics], (path) =>
    fileSystem.makeDirectory(path, { mode: 0o777 }).pipe(
      Effect.andThen(fileSystem.chmod(path, 0o777)),
    ), { discard: true });
  const rendered = yield* renderKustomize(paths.join(
    repository,
    "services",
    "otel-collector",
    "kubernetes",
    "overlays",
    options.overlay,
  ));
  const resources = yield* Schema.decodeUnknownEffect(
    Schema.Array(Resource),
  )(rendered);
  const source = yield* required(
    resources.find((resource) =>
      resource.kind === "ConfigMap" &&
      resource.metadata.name === "agentos-otel-collector"
    )?.data?.["collector.yaml"],
    "collector_config",
  );
  const withoutKubernetesMetadata = source.replace(
    /^\s+- k8sattributes\s*$/gm,
    "",
  );
  yield* fileSystem.writeFileString(
    configPath,
    options.transform?.(withoutKubernetesMetadata) ?? withoutKubernetesMetadata,
    { mode: 0o600 },
  );
  yield* fileSystem.writeFileString(
    headersPath,
    [
      "exporters:",
      "  otlp_http/remote:",
      "    headers:",
      '      x-agentos-test: "bounded"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { configPath, diagnostics, headersPath, storage };
});

layer(platform, { excludeTestServices: true })(
  "OpenTelemetry Collector outage conformance",
  (it) => {
    it.effect(
      "persists a privacy-filtered batch across remote outage and Collector restart",
      () => Effect.scoped(Effect.gen(function*() {
        const enabled = yield* Config.option(
          Config.string("AGENTOS_RUN_OTEL_E2E"),
        );
        if (Option.getOrUndefined(enabled) !== "true") return;

        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const repository = yield* paths.fromFileUrl(repositoryUrl);
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-otel-e2e-",
        });
        const storage = paths.join(directory, "storage");
        const configPath = paths.join(directory, "collector.yaml");
        const headersPath = paths.join(directory, "headers.yaml");
        const sink = yield* acquireOtlpTestSink();
        const port = yield* allocateBunTestPort();
        const name =
          `agentos-otel-e2e-${Math.abs(yield* Random.nextInt).toString(36)}`;
        yield* fileSystem.makeDirectory(storage, { mode: 0o777 });
        yield* fileSystem.chmod(storage, 0o777);
        const rendered = yield* renderKustomize(paths.join(
          repository,
          "services",
          "otel-collector",
          "kubernetes",
          "overlays",
          "remote",
        ));
        const resources = yield* Schema.decodeUnknownEffect(
          Schema.Array(Resource),
        )(rendered);
        const source = yield* required(
          resources.find((resource) =>
            resource.kind === "ConfigMap" &&
            resource.metadata.name === "agentos-otel-collector"
          )?.data?.["collector.yaml"],
          "collector_config",
        );
        const config = source.replace(/^\s+- k8sattributes\s*$/gm, "");
        yield* fileSystem.writeFileString(configPath, config, { mode: 0o600 });
        yield* fileSystem.writeFileString(
          headersPath,
          [
            "exporters:",
            "  otlp_http/remote:",
            "    headers:",
            '      x-agentos-test: "bounded"',
            "",
          ].join("\n"),
          { mode: 0o600 },
        );

        const options = {
          configPath,
          headersPath,
          name,
          port,
          remoteEndpoint: sink.remoteEndpoint,
          storage,
        };
        const trace = yield* Schema.encodeEffect(
          Schema.fromJsonString(TracePayload),
        )(seedTrace());
        const metric = yield* Schema.encodeEffect(
          Schema.fromJsonString(MetricPayload),
        )(seedMetric());
        const log = yield* Schema.encodeEffect(
          Schema.fromJsonString(LogPayload),
        )(seedLog());

        yield* Effect.gen(function*() {
          const first = yield* startCollector(options);
          yield* waitFor(
            "receiver_start",
            Effect.option(postTrace(port, '{"resourceSpans":[]}')).pipe(
              Effect.map((response) =>
                Option.isSome(response) && response.value.status === 200
              ),
            ),
          );
          assert.strictEqual((yield* postTrace(port, trace)).status, 200);
          assert.strictEqual((yield* postMetrics(port, metric)).status, 200);
          assert.strictEqual((yield* postLogs(port, log)).status, 200);
          yield* waitFor(
            "outage_observed",
            sink.requests.pipe(Effect.map((requests) =>
              requests.some((request) =>
                request.path === "/v1/traces" && !request.accepted
              )
            )),
          );

          yield* stopCollector(name);
          yield* first.exitCode;
          yield* sink.setAvailable(true);
          yield* startCollector(options);
          yield* waitFor(
            "receiver_restart",
            Effect.option(postTrace(port, '{"resourceSpans":[]}')).pipe(
              Effect.map((response) =>
                Option.isSome(response) && response.value.status === 200
              ),
            ),
          );
          yield* waitFor(
            "queued_batch_delivery",
            sink.requests.pipe(Effect.map((requests) =>
              requests.some((request) =>
                request.path === "/v1/traces" &&
                request.accepted &&
                new TextDecoder().decode(request.body).includes(
                  "safe.operation",
                )
              )
            )),
          );
          yield* waitFor(
            "queued_metric_delivery",
            sink.requests.pipe(Effect.map((requests) =>
              requests.some((request) =>
                request.path === "/v1/metrics" &&
                request.accepted &&
                new TextDecoder().decode(request.body).includes(
                  "agentos.test.cardinality",
                )
              )
            )),
          );
          yield* waitFor(
            "queued_log_delivery",
            sink.requests.pipe(Effect.map((requests) =>
              requests.some((request) =>
                request.path === "/v1/logs" &&
                request.accepted &&
                new TextDecoder().decode(request.body).includes(
                  AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
                )
              )
            )),
          );
          const accepted = yield* required(
            (yield* sink.requests).find((request) =>
              request.accepted &&
              new TextDecoder().decode(request.body).includes("safe.operation")
            ),
            "accepted_trace",
          );
          const serialized = new TextDecoder().decode(accepted.body);
          assert.include(serialized, "agentos.ai.runtime");
          assert.include(serialized, "pi");
          for (const forbidden of [
            "custom.safe_looking",
            "SEED_UNKNOWN_TRACE",
            "SEED_PROMPT",
            "sk-seeded-secret",
            "provider-account@example.test",
            "raw upstream private error",
          ]) {
            assert.notInclude(serialized, forbidden);
          }
          const acceptedMetric = yield* required(
            (yield* sink.requests).find((request) =>
              request.path === "/v1/metrics" &&
              request.accepted &&
              new TextDecoder().decode(request.body).includes(
                "agentos.test.cardinality",
              )
            ),
            "accepted_metric",
          );
          const serializedMetric = new TextDecoder().decode(
            acceptedMetric.body,
          );
          assert.include(serializedMetric, "agentos.ai.route");
          assert.include(serializedMetric, "ai_gateway");
          for (const forbidden of [
            "custom.safe_looking",
            "agentos.identity.agent_id",
            "agentos.memory.query",
            "agentos.repository.name",
            "10000000-0000-4000-8000-000000000001",
            "SEED_PRIVATE_MEMORY_QUERY",
            "SEED_UNKNOWN_METRIC",
            "private-repository",
          ]) {
            assert.notInclude(serializedMetric, forbidden);
          }
          const acceptedLog = yield* required(
            (yield* sink.requests).find((request) =>
              request.path === "/v1/logs" &&
              request.accepted &&
              new TextDecoder().decode(request.body).includes(
                AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
              )
            ),
            "accepted_log",
          );
          const serializedLog = new TextDecoder().decode(acceptedLog.body);
          assert.include(serializedLog, "agentos.ai.status_class");
          assert.include(serializedLog, "server_error");
          for (const forbidden of [
            "custom.resource",
            "custom.safe_looking",
            "SEED_PRIVATE_LOG_BODY",
            "SEED_UNKNOWN_LOG",
            "SEED_UNKNOWN_RESOURCE",
          ]) {
            assert.notInclude(serializedLog, forbidden);
          }
        }).pipe(
          Effect.ensuring(removeCollector(name).pipe(Effect.ignore)),
        );
      })),
      60_000,
    );

    it.effect(
      "rejects malformed and oversized OTLP while reporting authentication failure without leaking credentials",
      () => Effect.scoped(Effect.gen(function*() {
        if (!(yield* liveE2eEnabled())) return;
        const fixture = yield* acquireCollectorFixture({ overlay: "remote" });
        const sink = yield* acquireOtlpTestSink();
        yield* sink.setStatus(401);
        const [port, metricsPort, healthPort] = yield* Effect.all([
          allocateBunTestPort(),
          allocateBunTestPort(),
          allocateBunTestPort(),
        ]);
        const name =
          `agentos-otel-boundary-${Math.abs(yield* Random.nextInt).toString(36)}`;
        const collector = yield* startCollector({
          ...fixture,
          healthPort,
          metricsPort,
          name,
          port,
          remoteEndpoint: sink.remoteEndpoint,
        });
        yield* Effect.gen(function*() {
          yield* waitFor(
            "receiver_start",
            Effect.option(postTrace(port, '{"resourceSpans":[]}')).pipe(
              Effect.map((response) =>
                Option.isSome(response) && response.value.status === 200
              ),
            ),
          );
          assert.strictEqual(
            (yield* postTrace(port, "{not-json")).status,
            400,
          );
          const oversized = JSON.stringify({
            padding: "x".repeat(8_388_608),
            resourceSpans: [],
          });
          assert.strictEqual((yield* postTrace(port, oversized)).status, 400);
          const trace = yield* Schema.encodeEffect(
            Schema.fromJsonString(TracePayload),
          )(seedTrace());
          assert.strictEqual((yield* postTrace(port, trace)).status, 200);
          yield* waitFor(
            "authentication_failure",
            sink.requests.pipe(Effect.map((requests) =>
              requests.some((request) =>
                request.path === "/v1/traces" &&
                request.responseStatus === 401 &&
                request.credentialAuthorized
              )
            )),
          );
          yield* waitFor(
            "authentication_metric",
            Effect.option(
              getText(`http://127.0.0.1:${metricsPort}/metrics`),
            ).pipe(Effect.map((result) =>
              Option.isSome(result) && positiveMetric(
                result.value.body,
                "otelcol_exporter_send_failed_spans",
              )
            )),
          );
          const health = yield* getText(
            `http://127.0.0.1:${healthPort}/healthz`,
          );
          assert.deepStrictEqual(health, {
            body: '{"status":"ok"}',
            status: 200,
          });
          const metrics = yield* getText(
            `http://127.0.0.1:${metricsPort}/metrics`,
          );
          assert.notInclude(metrics.body, "bounded");
          assert.notInclude(metrics.body, "authorization");
        }).pipe(
          Effect.ensuring(removeCollector(name).pipe(Effect.ignore)),
          Effect.ensuring(collector.exitCode.pipe(Effect.ignore)),
        );
      })),
      60_000,
    );

    it.effect(
      "drops telemetry predictably when persistent queue storage is full or read-only",
      () => Effect.scoped(Effect.gen(function*() {
        if (!(yield* liveE2eEnabled())) return;
        const sink = yield* acquireOtlpTestSink();
        const batch = yield* Schema.encodeEffect(
          Schema.fromJsonString(TracePayload),
        )(seedTraceBatch(256));

        const fullFixture = yield* acquireCollectorFixture({
          overlay: "remote",
          transform: (source) =>
            source
              .replace("max_size: 536870912", "max_size: 1048576")
              .replace("on_rebound: true", "on_rebound: false"),
        });
        const [fullPort, fullMetricsPort] = yield* Effect.all([
          allocateBunTestPort(),
          allocateBunTestPort(),
        ]);
        const fullName =
          `agentos-otel-full-${Math.abs(yield* Random.nextInt).toString(36)}`;
        const fullCollector = yield* startCollector({
          ...fullFixture,
          metricsPort: fullMetricsPort,
          name: fullName,
          port: fullPort,
          remoteEndpoint: sink.remoteEndpoint,
        });
        yield* Effect.gen(function*() {
          yield* waitFor(
            "full_receiver_start",
            Effect.option(postTrace(fullPort, '{"resourceSpans":[]}')).pipe(
              Effect.map((response) =>
                Option.isSome(response) && response.value.status === 200
              ),
            ),
          );
          yield* Effect.forEach(
            Array.from({ length: 80 }),
            () => postTrace(fullPort, batch),
            { concurrency: 16, discard: true },
          );
          yield* waitFor(
            "full_storage_enqueue_failure",
            Effect.option(
              getText(`http://127.0.0.1:${fullMetricsPort}/metrics`),
            ).pipe(Effect.map((result) =>
              Option.isSome(result) && positiveMetric(
                result.value.body,
                "otelcol_exporter_enqueue_failed_spans",
              )
            )),
          );
        }).pipe(
          Effect.ensuring(removeCollector(fullName).pipe(Effect.ignore)),
          Effect.ensuring(fullCollector.exitCode.pipe(Effect.ignore)),
        );

        const readOnlyFixture = yield* acquireCollectorFixture({
          overlay: "remote",
        });
        const [readOnlyPort, readOnlyMetricsPort] = yield* Effect.all([
          allocateBunTestPort(),
          allocateBunTestPort(),
        ]);
        const readOnlyName =
          `agentos-otel-readonly-${Math.abs(yield* Random.nextInt).toString(36)}`;
        const readOnlyCollector = yield* startCollector({
          ...readOnlyFixture,
          metricsPort: readOnlyMetricsPort,
          name: readOnlyName,
          port: readOnlyPort,
          remoteEndpoint: sink.remoteEndpoint,
          storageReadOnly: true,
        });
        yield* Effect.gen(function*() {
          yield* waitFor(
            "read_only_storage_degraded",
            Effect.option(postTrace(readOnlyPort, batch)).pipe(
              Effect.flatMap((response) => {
                if (Option.isNone(response) || response.value.status !== 200) {
                  return Effect.succeed(true);
                }
                return Effect.option(
                  getText(`http://127.0.0.1:${readOnlyMetricsPort}/metrics`),
                ).pipe(Effect.map((metrics) =>
                  Option.isNone(metrics) || positiveMetric(
                    metrics.value.body,
                    "otelcol_exporter_enqueue_failed_spans",
                  )
                ));
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(removeCollector(readOnlyName).pipe(Effect.ignore)),
          Effect.ensuring(readOnlyCollector.exitCode.pipe(Effect.ignore)),
        );
      })),
      90_000,
    );

    it.effect(
      "rotates the optional local archive below its separate storage bound",
      () => Effect.scoped(Effect.gen(function*() {
        if (!(yield* liveE2eEnabled())) return;
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const fixture = yield* acquireCollectorFixture({
          overlay: "local-diagnostics",
          transform: (source) =>
            source
              .replace("max_megabytes: 32", "max_megabytes: 1")
              .replace("max_backups: 8", "max_backups: 2"),
        });
        const sink = yield* acquireOtlpTestSink();
        yield* sink.setAvailable(true);
        const port = yield* allocateBunTestPort();
        const name =
          `agentos-otel-archive-${Math.abs(yield* Random.nextInt).toString(36)}`;
        const collector = yield* startCollector({
          ...fixture,
          diagnostics: fixture.diagnostics,
          name,
          port,
          remoteEndpoint: sink.remoteEndpoint,
        });
        const batch = yield* Schema.encodeEffect(
          Schema.fromJsonString(TracePayload),
        )(seedTraceBatch(512));
        yield* Effect.gen(function*() {
          yield* waitFor(
            "archive_receiver_start",
            Effect.option(postTrace(port, '{"resourceSpans":[]}')).pipe(
              Effect.map((response) =>
                Option.isSome(response) && response.value.status === 200
              ),
            ),
          );
          yield* Effect.forEach(
            Array.from({ length: 32 }),
            () => postTrace(port, batch),
            { concurrency: 8, discard: true },
          );
          yield* waitFor(
            "archive_rotation",
            fileSystem.readDirectory(fixture.diagnostics).pipe(
              Effect.map((entries) => entries.length >= 2),
              Effect.orElseSucceed(() => false),
            ),
          );
          yield* Effect.sleep("2 seconds");
          const entries = (yield* fileSystem.readDirectory(fixture.diagnostics))
            .filter((entry) => entry.startsWith("telemetry"));
          assert.isAtLeast(entries.length, 2);
          assert.isAtMost(entries.length, 3);
          const sizes = yield* Effect.forEach(entries, (entry) =>
            fileSystem.stat(paths.join(fixture.diagnostics, entry)).pipe(
              Effect.map((info) => Number(info.size)),
            ));
          assert.isAtMost(
            sizes.reduce((total, size) => total + size, 0),
            8 * 1024 * 1024,
          );
        }).pipe(
          Effect.ensuring(removeCollector(name).pipe(Effect.ignore)),
          Effect.ensuring(collector.exitCode.pipe(Effect.ignore)),
        );
      })),
      90_000,
    );
  },
);
