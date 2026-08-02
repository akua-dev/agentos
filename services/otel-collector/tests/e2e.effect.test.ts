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
  readonly headersPath: string;
  readonly name: string;
  readonly port: number;
  readonly remoteEndpoint: string;
  readonly storage: string;
}) {
  return ChildProcess.make("docker", [
    "run",
    "--rm",
    "--name",
    options.name,
    "-p",
    `127.0.0.1:${options.port}:4318`,
    "-e",
    `OTEL_EXPORTER_OTLP_ENDPOINT=${options.remoteEndpoint}`,
    "-e",
    "K8S_NODE_NAME=test-node",
    "-v",
    `${options.configPath}:/etc/otelcol/collector.yaml:ro`,
    "-v",
    `${options.headersPath}:/etc/otelcol-secret/headers.yaml:ro`,
    "-v",
    `${options.storage}:/var/lib/otelcol`,
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
  return runCommand("docker", ["stop", "--time", "2", name]).pipe(
    Effect.asVoid,
  );
}

const postTrace = Effect.fn("test.otelE2e.postTrace")(function*(
  port: number,
  body: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(
    `http://127.0.0.1:${port}/v1/traces`,
  ).pipe(
    HttpClientRequest.setHeader("content-type", "application/json"),
    HttpClientRequest.bodyText(body, "application/json"),
  );
  return yield* client.execute(request).pipe(
    Effect.mapError(() => failure("post_trace", "http_failed")),
  );
});

const waitFor = Effect.fn("test.otelE2e.waitFor")(function*<R>(
  operation: string,
  check: Effect.Effect<boolean, never, R>,
) {
  yield* check.pipe(
    Effect.flatMap((ready) =>
      ready ? Effect.void : Effect.fail(failure(operation, "timeout"))
    ),
    Effect.retry({
      times: 150,
      schedule: Schedule.spaced("100 millis"),
    }),
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

layer(platform)("OpenTelemetry Collector outage conformance", (it) => {
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
      const name = `agentos-otel-e2e-${Math.abs(yield* Random.nextInt).toString(36)}`;
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
              new TextDecoder().decode(request.body).includes("safe.operation")
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
          "SEED_PROMPT",
          "sk-seeded-secret",
          "provider-account@example.test",
          "raw upstream private error",
        ]) {
          assert.notInclude(serialized, forbidden);
        }
      }).pipe(
        Effect.ensuring(stopCollector(name).pipe(Effect.ignore)),
      );
    })),
    45_000,
  );
});
