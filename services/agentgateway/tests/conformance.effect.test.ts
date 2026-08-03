import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Clock,
  Config,
  ConfigProvider,
  Console,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  connect as connectHttp2,
  createServer as createHttp2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { stringify } from "yaml";

import {
  acquireBunTestServer,
  allocateBunTestPort,
  decodeWebRequestJson,
  readWebRequestBytes,
  readWebRequestText,
} from "../../../tooling/testing/bun-http.ts";
import { parseYamlDocuments } from "../../../tooling/testing/kubernetes.ts";

const AllowedToken = "Bearer conformance-mate-token";
const BackendToken = "conformance-backend-token";
const ProviderToken = "conformance-provider-token";
const ExchangedToken = "conformance-exchanged-token";
const ProtectedMarker = "protected-payload-must-not-enter-telemetry";
const GrantHeaders: ReadonlyArray<string> = [
  "x-agentos-authz-schema-version",
  "x-agentos-authz-correlation-id",
  "x-agentos-authz-decision-ref",
  "x-agentos-authz-expires-at-millis",
  "x-agentos-authz-credential-domain",
  "x-agentos-authz-agent-id",
  "x-agentos-authz-role",
  "x-agentos-authz-fleet",
  "x-agentos-authz-domain",
  "x-agentos-authz-assignment-id",
  "x-agentos-authz-capability",
  "x-agentos-authz-resource-kind",
  "x-agentos-authz-provider",
  "x-agentos-authz-service",
  "x-agentos-authz-profile-id",
  "x-agentos-authz-profile-version",
  "x-agentos-authz-ceiling-id",
  "x-agentos-authz-ceiling-revision",
  "x-agentos-authz-rate-class",
];
const valuesUrl = new URL("../kubernetes/values.yaml", import.meta.url);

const BinarySha256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin":
    "f0fdc496b6dfd23f740bf458ff3a80c4453d7fd2397f0851bb42c5e00b6841d7",
  "aarch64-unknown-linux-gnu":
    "983a0919e30d287ec34ba51a69aa678fb81c5b893a59ae267b29d9fd30365d0e",
  "x86_64-unknown-linux-gnu":
    "20f7b298e0c36eef33e7d612b0d0b91d87d43124f59b01f6e9b730477f66d982",
};
const ChartSha256 =
  "b52cf0f6414c96c49f2d6976e09e24e6a035b913f5023e952cb0f6e95901ec86";

class ConformanceFailure extends Schema.TaggedErrorClass<ConformanceFailure>()(
  "ConformanceFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const VersionOutput = Schema.fromJsonString(Schema.Struct({
  build_target: Schema.String,
  git_revision: Schema.String,
  version: Schema.String,
}));

type CommandEnvironment = Readonly<Record<string, string>>;
type ConformanceResponse = {
  readonly body: string;
  readonly status: number;
};
type RequestOptions = {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "POST";
};

const encodeJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError((cause) =>
      ConformanceFailure.make({
        operation: "encode_json",
        message: String(cause),
      })
    ),
  );

const jsonResponse = Effect.fn("agentgatewayConformance.jsonResponse")(
  function*(value: unknown, status = 200) {
    const body = yield* encodeJson(value);
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  },
);

const commandEnvironment = Effect.fn(
  "agentgatewayConformance.commandEnvironment",
)(function*() {
  const configured = yield* Config.all({
    home: Config.option(Config.string("HOME")),
    kubeconfig: Config.option(Config.string("KUBECONFIG")),
    path: Config.string("PATH"),
    sslCertDirectory: Config.option(Config.string("SSL_CERT_DIR")),
    sslCertFile: Config.option(Config.string("SSL_CERT_FILE")),
  });
  const environment: Record<string, string> = { PATH: configured.path };
  for (const [name, option] of [
    ["HOME", configured.home],
    ["KUBECONFIG", configured.kubeconfig],
    ["SSL_CERT_DIR", configured.sslCertDirectory],
    ["SSL_CERT_FILE", configured.sslCertFile],
  ] satisfies ReadonlyArray<readonly [string, Option.Option<string>]>) {
    if (Option.isSome(option)) environment[name] = option.value;
  }
  return environment;
});

const fetchEffect = Effect.fn("agentgatewayConformance.fetch")(function* (
  url: string,
  options: RequestOptions = {},
) {
  let request = HttpClientRequest.make(options.method ?? "GET")(url);
  if (options.headers !== undefined) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }
  if (options.body !== undefined) {
    request = HttpClientRequest.bodyText(request, options.body);
  }
  return yield* Effect.scoped(Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "http_request",
          message: String(cause),
        })
      ),
    );
    const body = yield* response.text.pipe(
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "read_response",
          message: String(cause),
        })
      ),
    );
    return { body, status: response.status } satisfies ConformanceResponse;
  }));
});

const responseText = Effect.fn("agentgatewayConformance.responseText")(
  (response: ConformanceResponse) => Effect.succeed(response.body),
);

const responseJson = Effect.fn("agentgatewayConformance.responseJson")(
  function* (response: ConformanceResponse) {
    const body = yield* responseText(response);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRecord))(
      body,
    ).pipe(
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "decode_response",
          message: String(cause),
        }),
      ),
    );
  },
);

const runCommand = Effect.fn("agentgatewayConformance.runCommand")(function* (
  args: ReadonlyArray<string>,
  environment: CommandEnvironment,
) {
  const [command, ...commandArgs] = args;
  if (command === undefined) {
    return yield* ConformanceFailure.make({
      operation: "run_command",
      message: "command must not be empty",
    });
  }
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, commandArgs, {
      env: environment,
      extendEnv: false,
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
      ConformanceFailure.make({
        operation: "run_command",
        message: String(cause),
      })
    ),
  );
});

const sha256File = Effect.fn("agentgatewayConformance.sha256File")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* fs.readFile(file);
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes));
});

const eventually = Effect.fn("agentgatewayConformance.eventually")(function* <
  A,
  R,
>(
  operation: string,
  check: Effect.Effect<A, ConformanceFailure, R>,
  accept: (value: A) => boolean,
) {
  const start = yield* Clock.currentTimeMillis;
  while ((yield* Clock.currentTimeMillis) - start < 10_000) {
    const attempt = yield* Effect.option(check);
    if (Option.isSome(attempt) && accept(attempt.value)) return attempt.value;
    yield* Effect.sleep("50 millis");
  }
  return yield* ConformanceFailure.make({
    operation,
    message: "condition was not met within 10 seconds",
  });
});

const acquireServer = Effect.fn("agentgatewayConformance.acquireServer")(
  <E>(handler: (request: Request) => Effect.Effect<Response, E>) =>
    acquireBunTestServer(handler).pipe(
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "start_server",
          message: String(cause),
        })
      ),
    ),
);

const freePort = Effect.fn("agentgatewayConformance.freePort")(function* () {
  return yield* allocateBunTestPort().pipe(
    Effect.mapError((cause) =>
      ConformanceFailure.make({
        operation: "allocate_port",
        message: String(cause),
      })
    ),
  );
});

const acquireGrpcServer = Effect.fn(
  "agentgatewayConformance.acquireGrpcServer",
)(function* (
  calls: Array<{
    readonly authorization: string | null;
    readonly path: string;
  }>,
) {
  // Node HTTP/2 exposes only callback APIs; this named one-way host adapter
  // keeps acquisition, release, request failure, and cancellation in Effect.
  const server = createHttp2Server();
  server.on(
    "stream",
    (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      const chunks: Array<Buffer> = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const authorization = headers.authorization;
        const path = headers[":path"];
        calls.push({
          authorization:
            typeof authorization === "string" ? authorization : null,
          path: typeof path === "string" ? path : "",
        });
        stream.respond({
          ":status": 200,
          "content-type": "application/grpc",
          "grpc-status": "0",
        });
        stream.end(Buffer.concat(chunks));
      });
    },
  );
  return yield* Effect.acquireRelease(
    Effect.callback<
      { readonly port: number; readonly server: typeof server },
      ConformanceFailure
    >((resume) => {
      const onError = (cause: Error) =>
        resume(
          Effect.fail(
            ConformanceFailure.make({
              operation: "start_grpc_server",
              message: cause.message,
            }),
          ),
        );
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(
            Effect.fail(
              ConformanceFailure.make({
                operation: "start_grpc_server",
                message: "HTTP/2 server did not expose a TCP port",
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed({ port: address.port, server }));
      });
    }),
    ({ server: acquired }) =>
      Effect.callback<void>((resume) => {
        acquired.close(() => resume(Effect.void));
      }),
  );
});

const grpcCall = Effect.fn("agentgatewayConformance.grpcCall")(function* (
  port: number,
  payload: Uint8Array,
) {
  return yield* Effect.callback<
    { readonly body: Uint8Array; readonly status: number },
    ConformanceFailure
  >((resume) => {
    const client = connectHttp2(`http://127.0.0.1:${port}`);
    const request = client.request({
      ":method": "POST",
      ":path": "/agentos.conformance.Echo/Ping",
      authorization: AllowedToken,
      "content-type": "application/grpc",
      te: "trailers",
      "x-agentos-assignment-id": "assignment-conformance",
      "x-agentos-profile": "generic-grpc@v1",
    });
    const chunks: Array<Buffer> = [];
    let status = 0;
    const fail = (cause: Error) => {
      client.close();
      resume(
        Effect.fail(
          ConformanceFailure.make({
            operation: "grpc_call",
            message: cause.message,
          }),
        ),
      );
    };
    client.once("error", fail);
    request.once("error", fail);
    request.on("response", (headers) => {
      const value = headers[":status"];
      status = typeof value === "number" ? value : 0;
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      client.off("error", fail);
      request.off("error", fail);
      client.close();
      resume(
        Effect.succeed({
          body: new Uint8Array(Buffer.concat(chunks)),
          status,
        }),
      );
    });
    request.end(payload);
    return Effect.sync(() => client.close());
  });
});

function authzPolicy(port: number) {
  return {
    host: `127.0.0.1:${port}`,
    failureMode: "deny",
    includeRequestHeaders: [
      "authorization",
      "x-agentos-assignment-id",
    ],
    protocol: {
      http: {
        path: '"/authorize"',
        addRequestHeaders: {
          "x-agentos-original-method": "request.method",
          "x-agentos-original-path": "request.path",
        },
        includeResponseHeaders: ["x-agentos-subject", ...GrantHeaders],
      },
    },
  };
}

interface ConformancePorts {
  readonly admin: number;
  readonly gateway: number;
  readonly grpc: number;
  readonly llm: number;
  readonly mcp: number;
  readonly metrics: number;
  readonly oauth: number;
  readonly readiness: number;
  readonly telemetry: number;
}

function conformanceConfig(options: {
  readonly authzPort: number;
  readonly grpcPort: number;
  readonly mcpPort: number;
  readonly oauthPort: number;
  readonly ports: ConformancePorts;
  readonly upstreamPort: number;
}) {
  const extAuthz = authzPolicy(options.authzPort);
  return Effect.try({
    try: () => stringify({
    config: {
      adminAddr: `127.0.0.1:${options.ports.admin}`,
      statsAddr: `127.0.0.1:${options.ports.metrics}`,
      readinessAddr: `127.0.0.1:${options.ports.readiness}`,
      tracing: {
        otlpEndpoint: `http://127.0.0.1:${options.ports.telemetry}`,
        otlpProtocol: "http",
        randomSampling: true,
      },
    },
    gateways: {
      governed: { port: options.ports.gateway },
      grpc: { port: options.ports.grpc },
      llm: { port: options.ports.llm },
      mcp: { port: options.ports.mcp },
      oauth: { port: options.ports.oauth },
    },
    routes: [
      {
        gateways: ["governed"],
        matches: [{ path: { exact: "/retry" } }],
        policies: {
          extAuthz,
          retry: { attempts: 2, codes: [503] },
          timeout: { requestTimeout: "3s" },
        },
        backends: [
          {
            host: `127.0.0.1:${options.upstreamPort}`,
            policies: {
              http: { requestTimeout: "2s" },
            },
          },
        ],
      },
      {
        gateways: ["governed"],
        policies: {
          extAuthz,
          timeout: { requestTimeout: "3s" },
        },
        backends: [
          {
            host: `127.0.0.1:${options.upstreamPort}`,
            policies: {
              http: { requestTimeout: "2s" },
            },
          },
        ],
      },
      {
        gateways: ["grpc"],
        policies: { extAuthz },
        backends: [
          {
            host: `127.0.0.1:${options.grpcPort}`,
            policies: {
              backendAuth: { key: "$CONFORMANCE_BACKEND_TOKEN" },
              http: { version: "HTTP/2.0", requestTimeout: "2s" },
            },
          },
        ],
      },
      {
        gateways: ["oauth"],
        policies: { extAuthz },
        backends: [
          {
            host: `127.0.0.1:${options.upstreamPort}`,
            policies: {
              backendAuth: {
                oauthTokenExchange: {
                  host: `127.0.0.1:${options.oauthPort}`,
                  path: "/token",
                  clientAuth: {
                    clientId: "agentos-conformance",
                    clientSecret: "$CONFORMANCE_OAUTH_CLIENT_SECRET",
                    method: "clientSecretBasic",
                  },
                  audiences: ["agentos-upstream"],
                },
              },
            },
          },
        ],
      },
    ],
    llm: {
      gateways: ["llm"],
      policies: { extAuthz },
      models: [
        {
          name: "conformance-model",
          provider: {
            custom: { formats: [{ type: "responses" }] },
          },
          params: {
            apiKey: "$CONFORMANCE_PROVIDER_TOKEN",
            baseUrl: `http://127.0.0.1:${options.upstreamPort}/v1`,
          },
        },
      ],
    },
    mcp: {
      gateways: ["mcp"],
      policies: {
        extAuthz,
        backendAuth: { key: "$CONFORMANCE_BACKEND_TOKEN" },
      },
      targets: [
        {
          name: "conformance",
          mcp: { host: `http://127.0.0.1:${options.mcpPort}/mcp` },
        },
      ],
    },
    }),
    catch: (cause) =>
      ConformanceFailure.make({
        operation: "encode_config",
        message: String(cause),
      }),
  });
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function renderedResource(
  documents: ReadonlyArray<Record<string, unknown>>,
  kind: string,
) {
  return documents.find((document) => document.kind === kind);
}

function methodOf(value: unknown): string {
  const method = recordOf(value).method;
  return typeof method === "string" ? method : "";
}

function idOf(value: unknown): unknown {
  return recordOf(value).id ?? null;
}

function modernMcpResult(method: string) {
  switch (method) {
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: ["2025-06-18", "2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "agentos-conformance", version: "1.0.0" },
        ttlMs: 0,
        cacheScope: "private",
      };
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agentos-conformance", version: "1.0.0" },
      };
    case "tools/list":
      return {
        resultType: "complete",
        tools: [
          {
            name: "echo",
            description: "Echo a value",
            inputSchema: { type: "object" },
          },
        ],
      };
    default:
      return undefined;
  }
}

function completedResponse() {
  return {
    id: "resp_agentos_conformance",
    object: "response",
    created_at: 1_785_556_800,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "conformance-model",
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    metadata: {},
  };
}

function authorizedHeaders() {
  return {
    authorization: AllowedToken,
    "content-type": "application/json",
    "x-agentos-assignment-id": "assignment-conformance",
    "x-agentos-authz-decision-ref":
      "decision_ffffffffffffffffffffffffffffffff",
    "x-agentos-profile": "openai-responses@v1",
  };
}

const readMetrics = Effect.fn("agentgatewayConformance.readMetrics")(function* (
  port: number,
) {
  return yield* fetchEffect(`http://127.0.0.1:${port}/metrics`).pipe(
    Effect.flatMap(responseText),
  );
});

const timedRequest = Effect.fn("agentgatewayConformance.timedRequest")(
  function* (url: string, headers?: Readonly<Record<string, string>>) {
    const started = yield* Clock.currentTimeNanos;
    const response = yield* fetchEffect(url, { headers });
    assert.strictEqual(response.status, 200);
    yield* responseText(response);
    const ended = yield* Clock.currentTimeNanos;
    return Number(ended - started) / 1_000_000;
  },
);

const readFirstStreamChunk = Effect.fn(
  "agentgatewayConformance.readFirstStreamChunk",
)(function*(url: string, headers: Readonly<Record<string, string>>) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
    );
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "stream_request",
          message: String(cause),
        })
      ),
    );
    const first = yield* response.stream.pipe(
      Stream.runHead,
      Effect.mapError((cause) =>
        ConformanceFailure.make({
          operation: "read_stream",
          message: String(cause),
        })
      ),
    );
    return { hasChunk: Option.isSome(first), status: response.status };
  }));
});

function percentile(samples: ReadonlyArray<number>, quantile: number) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

const conformance = Effect.scoped(Effect.gen(function*() {
            const configured = yield* Config.all({
              binary: Config.option(
                Config.string("AGENTOS_AGENTGATEWAY_BIN"),
              ),
              chart: Config.option(
                Config.string("AGENTOS_AGENTGATEWAY_CHART"),
              ),
            });
            if (
              Option.isNone(configured.binary) ||
              Option.isNone(configured.chart)
            ) return;
            const executable = configured.binary.value;
            const chart = configured.chart.value;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const valuesPath = yield* path.fromFileUrl(valuesUrl);
            const environment = yield* commandEnvironment();
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "agentos-agentgateway-conformance-",
            });

            const version = yield* runCommand(
              [executable, "--version"],
              environment,
            );
            assert.strictEqual(version.exitCode, 0, version.stderr);
            const versionOutput = yield* Schema.decodeUnknownEffect(
              VersionOutput,
            )(version.stdout).pipe(
              Effect.mapError((cause) =>
                ConformanceFailure.make({
                  operation: "decode_version",
                  message: String(cause),
                })
              ),
            );
            assert.strictEqual(versionOutput.version, "1.4.1");
            assert.strictEqual(
              versionOutput.git_revision,
              "163ea2146acb7b82082acea30ed691b29079095f",
            );
            const expectedBinarySha = BinarySha256[versionOutput.build_target];
            if (expectedBinarySha === undefined) {
              return yield* ConformanceFailure.make({
                operation: "unsupported_binary_target",
                message: versionOutput.build_target,
              });
            }
            assert.strictEqual(
              yield* sha256File(executable),
              expectedBinarySha,
            );
            assert.strictEqual(yield* sha256File(chart), ChartSha256);

            const rendered = yield* runCommand([
              "helm",
              "template",
              "agentgateway-openai",
              chart,
              "--namespace",
              "agentos",
              "-f",
              valuesPath,
            ], environment);
            assert.strictEqual(rendered.exitCode, 0, rendered.stderr);
            const renderedDocuments = (yield* parseYamlDocuments(
              rendered.stdout,
            ))
              .map(recordOf)
              .filter((document) => typeof document.kind === "string");
            const deployment = renderedResource(
              renderedDocuments,
              "Deployment",
            );
            const service = renderedResource(renderedDocuments, "Service");
            const configMap = renderedResource(renderedDocuments, "ConfigMap");
            assert.ok(deployment !== undefined);
            assert.ok(service !== undefined);
            assert.ok(configMap !== undefined);
            assert.strictEqual(recordOf(service.spec).type, "ClusterIP");
            const podSpec = recordOf(
              recordOf(recordOf(deployment.spec).template).spec,
            );
            assert.strictEqual(podSpec.automountServiceAccountToken, undefined);
            const containers = Array.isArray(podSpec.containers)
              ? podSpec.containers
              : [];
            const gatewayContainer = recordOf(containers[0]);
            assert.strictEqual(
              gatewayContainer.image,
              "cr.agentgateway.dev/agentgateway@sha256:efd79355b89094a8225a9db465d9a01dc656b377f0bab458761b935a13231d29",
            );
            const providerMounts = Array.isArray(gatewayContainer.volumeMounts)
              ? gatewayContainer.volumeMounts
              : [];
            assert.deepStrictEqual(
              providerMounts.filter(
                (mount) =>
                  recordOf(mount).name === "provider-credential-openai",
              ),
              [],
            );
            const providerVolumes = Array.isArray(podSpec.volumes)
              ? podSpec.volumes
              : [];
            assert.deepStrictEqual(
              providerVolumes.filter(
                (volume) =>
                  recordOf(volume).name === "provider-credential-openai",
              ),
              [],
            );
            assert.strictEqual(
              renderedResource(renderedDocuments, "NetworkPolicy"),
              undefined,
            );
            assert.strictEqual(
              renderedResource(renderedDocuments, "PodDisruptionBudget"),
              undefined,
            );
            assert.strictEqual(
              renderedResource(renderedDocuments, "PodMonitor"),
              undefined,
            );
            const renderedConfig = recordOf(configMap.data)["config.yaml"];
            assert.strictEqual(typeof renderedConfig, "string");
            const validationConfig = typeof renderedConfig === "string"
              ? renderedConfig
              : "";
            const renderedValidation = yield* runCommand(
              [
                executable,
                "--validate-only",
                "-c",
                validationConfig,
              ],
              environment,
            );
            assert.strictEqual(
              renderedValidation.exitCode,
              0,
              renderedValidation.stderr,
            );

            const authorizationRequests: Array<{
              readonly authorization: string | null;
              readonly method: string | null;
              readonly originalPath: string | null;
              readonly path: string;
            }> = [];
            const upstreamRequests: Array<{
              readonly assignmentId: string | null;
              readonly authorization: string | null;
              readonly decisionRef: string | null;
              readonly path: string;
              readonly subject: string | null;
            }> = [];
            const telemetryBodies: Array<Uint8Array> = [];
            const grpcRequests: Array<{
              readonly authorization: string | null;
              readonly path: string;
            }> = [];
            const oauthRequests: Array<{
              readonly authorization: string | null;
              readonly body: string;
            }> = [];
            const streamCancelled = yield* Ref.make(false);
            const streamPulls = yield* Ref.make(0);
            const retryAttempts = yield* Ref.make(0);

            const authz = yield* acquireServer((request) =>
              Effect.gen(function*() {
                const requestUrl = new URL(request.url);
                yield* Effect.sync(() =>
                  authorizationRequests.push({
                    authorization: request.headers.get("authorization"),
                    method: request.headers.get("x-agentos-original-method"),
                    originalPath: request.headers.get("x-agentos-original-path"),
                    path: requestUrl.pathname,
                  })
                );
                if (request.headers.get("authorization") !== AllowedToken) {
                  return new Response(
                    yield* encodeJson({ error: "identity_denied" }),
                    {
                      status: 403,
                      headers: {
                        "content-type": "application/json",
                        "x-agentos-error-kind": "identity_denied",
                      },
                    },
                  );
                }
                return new Response(null, {
                  status: 200,
                  headers: {
                    "x-agentos-subject": "mate-conformance",
                    "x-agentos-authz-schema-version": "1",
                    "x-agentos-authz-correlation-id":
                      "corr_00000000000000000000000000000001",
                    "x-agentos-authz-decision-ref":
                      "decision_00000000000000000000000000000001",
                    "x-agentos-authz-expires-at-millis": "1785556860000",
                    "x-agentos-authz-credential-domain": "openai-responses",
                    "x-agentos-authz-agent-id":
                      "10000000-0000-4000-8000-000000000001",
                    "x-agentos-authz-role": "first_mate",
                    "x-agentos-authz-fleet": "default",
                    "x-agentos-authz-domain": "agentos",
                    "x-agentos-authz-assignment-id":
                      request.headers.has("x-agentos-assignment-id")
                        ? "20000000-0000-4000-8000-000000000001"
                        : "",
                    "x-agentos-authz-capability": "openai.responses.create",
                    "x-agentos-authz-resource-kind": "provider_service",
                    "x-agentos-authz-provider": "openai",
                    "x-agentos-authz-service": "responses",
                    "x-agentos-authz-profile-id": "openai-responses",
                    "x-agentos-authz-profile-version": "1",
                    "x-agentos-authz-ceiling-id": "fleet-openai",
                    "x-agentos-authz-ceiling-revision": "1",
                    "x-agentos-authz-rate-class": "standard",
                  },
                });
              })
            );

            const upstream = yield* acquireServer((request) =>
              Effect.gen(function*() {
                const requestUrl = new URL(request.url);
                yield* Effect.sync(() =>
                  upstreamRequests.push({
                    assignmentId: request.headers.get(
                      "x-agentos-authz-assignment-id",
                    ),
                    authorization: request.headers.get("authorization"),
                    decisionRef: request.headers.get(
                      "x-agentos-authz-decision-ref",
                    ),
                    path: requestUrl.pathname,
                    subject: request.headers.get("x-agentos-subject"),
                  })
                );
                if (requestUrl.pathname === "/stream") {
                  const chunk = new Uint8Array(64 * 1024).fill(97);
                  const responseStream = Stream.fromEffectRepeat(
                    Ref.updateAndGet(streamPulls, (pulls) => pulls + 1).pipe(
                      Effect.as(chunk),
                    ),
                  ).pipe(
                    Stream.take(511),
                    Stream.ensuring(Ref.set(streamCancelled, true)),
                  );
                  const body = yield* Stream.toReadableStreamEffect(
                    responseStream,
                  );
                  return new Response(body, {
                    headers: { "content-type": "application/octet-stream" },
                  });
                }
                if (requestUrl.pathname === "/provider-429") {
                  return yield* jsonResponse(
                    { error: { type: "rate_limit", message: "conformance" } },
                    429,
                  );
                }
                if (requestUrl.pathname === "/retry") {
                  const attempt = yield* Ref.updateAndGet(
                    retryAttempts,
                    (attempts) => attempts + 1,
                  );
                  if (attempt === 1) {
                    return yield* jsonResponse(
                      { error: { type: "temporary" } },
                      503,
                    );
                  }
                }
                if (requestUrl.pathname === "/v1/responses/compact") {
                  return yield* jsonResponse({
                    type: "compaction",
                    encrypted_content: "opaque-agentos-compaction-artifact",
                  });
                }
                if (requestUrl.pathname === "/v1/responses") {
                  return yield* jsonResponse(completedResponse());
                }
                return yield* jsonResponse({
                  path: requestUrl.pathname,
                  authorization: request.headers.get("authorization"),
                  decisionRef: request.headers.get(
                    "x-agentos-authz-decision-ref",
                  ),
                  subject: request.headers.get("x-agentos-subject"),
                });
              })
            );

            const mcp = yield* acquireServer((request) =>
              decodeWebRequestJson(JsonRecord)(request).pipe(
                Effect.mapError((cause) =>
                  ConformanceFailure.make({
                    operation: "decode_mcp_request",
                    message: String(cause),
                  })
                ),
                Effect.flatMap((body) => {
                  const method = methodOf(body);
                  const result = modernMcpResult(method);
                  return result === undefined
                    ? jsonResponse({
                      jsonrpc: "2.0",
                      id: idOf(body),
                      error: { code: -32601, message: method },
                    })
                    : jsonResponse({
                      jsonrpc: "2.0",
                      id: idOf(body),
                      result,
                    });
                }),
              )
            );

            const telemetry = yield* acquireServer((request) =>
              readWebRequestBytes(request).pipe(
                Effect.tap((body) =>
                  Effect.sync(() => telemetryBodies.push(body))
                ),
                Effect.as(new Response(null, { status: 200 })),
              )
            );
            const grpc = yield* acquireGrpcServer(grpcRequests);
            const oauth = yield* acquireServer((request) =>
              readWebRequestText(request).pipe(
                Effect.tap((body) =>
                  Effect.sync(() =>
                    oauthRequests.push({
                      authorization: request.headers.get("authorization"),
                      body,
                    })
                  )
                ),
                Effect.flatMap(() =>
                  jsonResponse({
                    access_token: ExchangedToken,
                    expires_in: 60,
                    token_type: "Bearer",
                  })
                ),
              )
            );

            const ports: ConformancePorts = {
              admin: yield* freePort(),
              gateway: yield* freePort(),
              grpc: yield* freePort(),
              llm: yield* freePort(),
              mcp: yield* freePort(),
              metrics: yield* freePort(),
              oauth: yield* freePort(),
              readiness: yield* freePort(),
              telemetry: telemetry.port,
            };
            const configPath = path.join(root, "config.yaml");
            const initialConfig = yield* conformanceConfig({
              authzPort: authz.port,
              grpcPort: grpc.port,
              mcpPort: mcp.port,
              oauthPort: oauth.port,
              ports,
              upstreamPort: upstream.port,
            });
            yield* fs.writeFileString(configPath, initialConfig);
            const gatewayEnvironment = {
              ...environment,
              CONFORMANCE_BACKEND_TOKEN: BackendToken,
              CONFORMANCE_PROVIDER_TOKEN: ProviderToken,
              CONFORMANCE_OAUTH_CLIENT_SECRET: "conformance-client-secret",
            };
            const validation = yield* runCommand(
              [executable, "--validate-only", "-f", configPath],
              gatewayEnvironment,
            );
            assert.strictEqual(
              validation.exitCode,
              0,
              `${validation.stdout} ${validation.stderr}`,
            );

            const gatewayOutput = yield* Ref.make("");
            const gateway = yield* ChildProcess.make(
              executable,
              ["-f", configPath],
              {
                env: gatewayEnvironment,
                extendEnv: false,
                forceKillAfter: "1 second",
                killSignal: "SIGTERM",
                stderr: "pipe",
                stdout: "pipe",
              },
            ).pipe(
              Effect.mapError((cause) =>
                ConformanceFailure.make({
                  operation: "start_gateway",
                  message: String(cause),
                })
              ),
            );
            yield* gateway.all.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Ref.update(gatewayOutput, (output) => output + chunk)
              ),
              Effect.forkScoped,
            );

            yield* eventually(
              "gateway_readiness",
              fetchEffect(`http://127.0.0.1:${ports.readiness}/healthz/ready`),
              (response) => response.status === 200,
            );

            const denied = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/echo`,
            );
            assert.strictEqual(denied.status, 403);
            assert.ok(
              (yield* responseText(denied)).includes("identity_denied"),
            );
            assert.strictEqual(upstreamRequests.length, 0);

            const echo = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/echo`,
              { headers: authorizedHeaders() },
            );
            assert.strictEqual(echo.status, 200);
            assert.deepStrictEqual(yield* responseJson(echo), {
              path: "/echo",
              authorization: AllowedToken,
              decisionRef: "decision_00000000000000000000000000000001",
              subject: "mate-conformance",
            });
            assert.strictEqual(
              authorizationRequests.at(-1)?.authorization,
              AllowedToken,
            );
            assert.strictEqual(
              upstreamRequests.at(-1)?.authorization,
              AllowedToken,
            );
            assert.deepStrictEqual(authorizationRequests.at(-1), {
              authorization: AllowedToken,
              method: "GET",
              originalPath: "/echo",
              path: "/authorize",
            });

            const mateWithoutAssignment = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/echo`,
              {
                headers: {
                  authorization: AllowedToken,
                  "x-agentos-authz-assignment-id":
                    "20000000-0000-4000-8000-000000000099",
                },
              },
            );
            assert.strictEqual(mateWithoutAssignment.status, 200);
            assert.strictEqual(upstreamRequests.at(-1)?.assignmentId, "");

            for (let index = 0; index < 3; index += 1) {
              yield* timedRequest(`http://127.0.0.1:${upstream.port}/latency`);
              yield* timedRequest(
                `http://127.0.0.1:${ports.gateway}/latency`,
                authorizedHeaders(),
              );
            }
            const directLatency: Array<number> = [];
            const governedLatency: Array<number> = [];
            for (let index = 0; index < 20; index += 1) {
              directLatency.push(
                yield* timedRequest(
                  `http://127.0.0.1:${upstream.port}/latency`,
                ),
              );
              governedLatency.push(
                yield* timedRequest(
                  `http://127.0.0.1:${ports.gateway}/latency`,
                  authorizedHeaders(),
                ),
              );
            }
            const directP50 = percentile(directLatency, 0.5);
            const governedP50 = percentile(governedLatency, 0.5);
            const latencyMetrics = yield* encodeJson({
              directP50: Number(directP50.toFixed(3)),
              directP95: Number(percentile(directLatency, 0.95).toFixed(3)),
              governedP50: Number(governedP50.toFixed(3)),
              governedP95: Number(
                percentile(governedLatency, 0.95).toFixed(3),
              ),
              medianDelta: Number((governedP50 - directP50).toFixed(3)),
              samples: directLatency.length,
            });
            yield* Console.log(`agentgateway_latency_ms ${latencyMetrics}`);

            const grpcFrame = new Uint8Array([0, 0, 0, 0, 3, 8, 150, 1]);
            const grpcResponse = yield* grpcCall(ports.grpc, grpcFrame);
            assert.strictEqual(grpcResponse.status, 200);
            assert.deepStrictEqual(grpcResponse.body, grpcFrame);
            assert.deepStrictEqual(grpcRequests.at(-1), {
              authorization: `Bearer ${BackendToken}`,
              path: "/agentos.conformance.Echo/Ping",
            });

            const retried = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/retry`,
              { headers: authorizedHeaders() },
            );
            assert.strictEqual(retried.status, 200);
            assert.strictEqual(yield* Ref.get(retryAttempts), 2);

            const exchanged = yield* fetchEffect(
              `http://127.0.0.1:${ports.oauth}/oauth`,
              { headers: authorizedHeaders() },
            );
            assert.strictEqual(exchanged.status, 200);
            assert.strictEqual(
              upstreamRequests.at(-1)?.authorization,
              `Bearer ${ExchangedToken}`,
            );
            assert.ok(
              oauthRequests
                .at(-1)
                ?.body.includes(
                  "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
                ),
            );
            assert.ok(
              oauthRequests
                .at(-1)
                ?.body.includes("subject_token=conformance-mate-token"),
            );

            const compact = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/v1/responses/compact`,
              {
                method: "POST",
                headers: authorizedHeaders(),
                body: yield* encodeJson({
                  model: "conformance-model",
                  input: [{ role: "user", content: ProtectedMarker }],
                }),
              },
            );
            assert.strictEqual(compact.status, 200);
            assert.deepStrictEqual(yield* responseJson(compact), {
              type: "compaction",
              encrypted_content: "opaque-agentos-compaction-artifact",
            });

            const llm = yield* fetchEffect(
              `http://127.0.0.1:${ports.llm}/v1/responses`,
              {
                method: "POST",
                headers: authorizedHeaders(),
                body: yield* encodeJson({
                  model: "conformance-model",
                  input: "hello",
                }),
              },
            );
            assert.strictEqual(llm.status, 200);
            assert.strictEqual((yield* responseJson(llm)).object, "response");
            assert.strictEqual(
              upstreamRequests.at(-1)?.authorization,
              `Bearer ${ProviderToken}`,
            );

            const rateLimited = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/provider-429`,
              { headers: authorizedHeaders() },
            );
            assert.strictEqual(rateLimited.status, 429);

            const modernMeta = {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "agentos-conformance",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            };
            const mcpList = yield* fetchEffect(
              `http://127.0.0.1:${ports.mcp}/mcp`,
              {
                method: "POST",
                headers: {
                  ...authorizedHeaders(),
                  accept: "application/json, text/event-stream",
                  "mcp-method": "tools/list",
                  "mcp-protocol-version": "2026-07-28",
                },
                body: yield* encodeJson({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/list",
                  params: { _meta: modernMeta },
                }),
              },
            );
            assert.strictEqual(mcpList.status, 200);
            assert.ok((yield* responseText(mcpList)).includes("echo"));

            const streamed = yield* readFirstStreamChunk(
              `http://127.0.0.1:${ports.gateway}/stream`,
              authorizedHeaders(),
            );
            assert.strictEqual(streamed.status, 200);
            assert.isTrue(streamed.hasChunk);
            yield* Effect.sleep("100 millis");
            assert.ok((yield* Ref.get(streamPulls)) < 512);
            yield* eventually(
              "upstream_stream_cancellation",
              Ref.get(streamCancelled),
              (cancelled) => cancelled,
            );

            yield* eventually(
              "telemetry_export",
              Effect.sync(() => telemetryBodies.length),
              (count) => count > 0,
            );
            const telemetryText = telemetryBodies
              .map((body) => new TextDecoder().decode(body))
              .join("\n");
            assert.ok(!telemetryText.includes(ProtectedMarker));
            assert.ok(!telemetryText.includes(AllowedToken));
            assert.ok(!telemetryText.includes(BackendToken));
            assert.ok(!telemetryText.includes(ProviderToken));
            assert.ok(!telemetryText.includes(ExchangedToken));
            assert.ok(!telemetryText.includes("conformance-client-secret"));

            const metricsBeforeReload = yield* readMetrics(ports.metrics);
            assert.match(
              metricsBeforeReload,
              /config_synchronized\s+1(?:\.0+)?/,
            );

            yield* fs.writeFileString(configPath, "routes: invalid\n");
            yield* eventually(
              "invalid_reload_signal",
              readMetrics(ports.metrics),
              (metrics) => /config_synchronized\s+0(?:\.0+)?/.test(metrics),
            );
            const readyAfterInvalidReload = yield* fetchEffect(
              `http://127.0.0.1:${ports.readiness}/healthz/ready`,
            );
            assert.strictEqual(readyAfterInvalidReload.status, 200);
            const retainedRoute = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/retained`,
              { headers: authorizedHeaders() },
            );
            assert.strictEqual(retainedRoute.status, 200);

            yield* fs.writeFileString(configPath, initialConfig);
            yield* eventually(
              "repaired_reload_signal",
              readMetrics(ports.metrics),
              (metrics) => /config_synchronized\s+1(?:\.0+)?/.test(metrics),
            );

            assert.isTrue(yield* gateway.isRunning);
            const gatewayLogs = yield* Ref.get(gatewayOutput);
            for (const protectedValue of [
              ProtectedMarker,
              AllowedToken,
              BackendToken,
              ProviderToken,
              ExchangedToken,
              "conformance-client-secret",
            ]) {
              assert.notInclude(gatewayLogs, protectedValue);
            }
}));

const platform = Layer.mergeAll(
  BunServices.layer,
  BunHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

layer(platform)("agentgateway v1.4.1 semantic conformance", (it) => {
  it.effect("reports invalid subprocess contracts as tagged failures", () =>
    Effect.gen(function*() {
      const failure = yield* runCommand([], {}).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ConformanceFailure");
      assert.strictEqual(failure.operation, "run_command");
    }));

  it.effect(
    "preserves AgentOS authorization, credential, provider, stream, MCP, telemetry, and reload semantics",
    () => TestClock.withLive(conformance),
    60_000,
  );
});
