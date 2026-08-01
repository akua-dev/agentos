import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, test } from "bun:test";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  connect as connectHttp2,
  createServer as createHttp2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";

const AllowedToken = "Bearer conformance-mate-token";
const BackendToken = "conformance-backend-token";
const ProviderToken = "conformance-provider-token";
const ExchangedToken = "conformance-exchanged-token";
const ProtectedMarker = "protected-payload-must-not-enter-telemetry";
const valuesPath = fileURLToPath(
  new URL("../kubernetes/values.yaml", import.meta.url),
);

const BinarySha256 = {
  "darwin-arm64":
    "f0fdc496b6dfd23f740bf458ff3a80c4453d7fd2397f0851bb42c5e00b6841d7",
  "linux-arm64":
    "983a0919e30d287ec34ba51a69aa678fb81c5b893a59ae267b29d9fd30365d0e",
  "linux-x64":
    "20f7b298e0c36eef33e7d612b0d0b91d87d43124f59b01f6e9b730477f66d982",
} as const;
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

const fetchEffect = Effect.fn("agentgatewayConformance.fetch")(function* (
  url: string,
  init?: RequestInit,
) {
  return yield* Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (cause) =>
      ConformanceFailure.make({
        operation: "http_request",
        message: String(cause),
      }),
  });
});

const responseText = Effect.fn("agentgatewayConformance.responseText")(
  function* (response: Response) {
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        ConformanceFailure.make({
          operation: "read_response",
          message: String(cause),
        }),
    });
  },
);

const responseJson = Effect.fn("agentgatewayConformance.responseJson")(
  function* (response: Response) {
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
  args: Array<string>,
  environment?: Record<string, string>,
) {
  const process = yield* Effect.sync(() => {
    const child = Bun.spawn(args, {
      env: environment === undefined ? undefined : environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      child,
      stderr: new Response(child.stderr).text(),
      stdout: new Response(child.stdout).text(),
    };
  });
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => process.child.exited,
        catch: (cause) =>
          ConformanceFailure.make({
            operation: "run_command",
            message: String(cause),
          }),
      }),
      Effect.promise(() => process.stdout),
      Effect.promise(() => process.stderr),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, stderr, stdout };
});

const sha256File = Effect.fn("agentgatewayConformance.sha256File")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
});

const eventually = Effect.fn("agentgatewayConformance.eventually")(function* <
  A,
>(
  operation: string,
  check: Effect.Effect<A, ConformanceFailure>,
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
  function* (fetchHandler: (request: Request) => Response | Promise<Response>) {
    return yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: fetchHandler,
          });
          const port = server.port;
          if (port === undefined) {
            server.stop(true);
            throw new Error("Bun did not allocate a server port");
          }
          return { port, server };
        },
        catch: (cause) =>
          ConformanceFailure.make({
            operation: "start_server",
            message: String(cause),
          }),
      }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    );
  },
);

const freePort = Effect.fn("agentgatewayConformance.freePort")(function* () {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  server.stop(true);
  if (port !== undefined) return port;
  return yield* ConformanceFailure.make({
    operation: "allocate_port",
    message: "Bun did not allocate a port",
  });
});

const acquireGrpcServer = Effect.fn(
  "agentgatewayConformance.acquireGrpcServer",
)(function* (
  calls: Array<{
    readonly authorization: string | null;
    readonly path: string;
  }>,
) {
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
      "x-agentos-profile",
      ":method",
      ":path",
    ],
    protocol: {
      http: {
        path: '"/authorize"',
        includeResponseHeaders: ["x-agentos-subject"],
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
  return stringify({
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
              backendAuth: { key: "$CONFORMANCE_BACKEND_TOKEN" },
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
              backendAuth: { key: "$CONFORMANCE_BACKEND_TOKEN" },
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
  function* (url: string, headers?: RequestInit["headers"]) {
    const started = yield* Effect.sync(() => performance.now());
    const response = yield* fetchEffect(url, { headers });
    assert.strictEqual(response.status, 200);
    yield* responseText(response);
    const ended = yield* Effect.sync(() => performance.now());
    return ended - started;
  },
);

function percentile(samples: ReadonlyArray<number>, quantile: number) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

describe("agentgateway v1.4.1 semantic conformance", () => {
  const conformanceTest =
    process.env.AGENTOS_AGENTGATEWAY_BIN === undefined ||
    process.env.AGENTOS_AGENTGATEWAY_CHART === undefined
      ? test.skip
      : test;
  conformanceTest(
    "preserves AgentOS authorization, credential, provider, stream, MCP, telemetry, and reload semantics",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const executable = yield* Config.string("AGENTOS_AGENTGATEWAY_BIN");
            const chart = yield* Config.string("AGENTOS_AGENTGATEWAY_CHART");
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: "agentos-agentgateway-conformance-",
            });

            const platformKey =
              `${process.platform}-${process.arch}` as keyof typeof BinarySha256;
            const expectedBinarySha = BinarySha256[platformKey];
            assert.ok(
              expectedBinarySha !== undefined,
              `unsupported conformance platform ${platformKey}`,
            );
            assert.strictEqual(
              yield* sha256File(executable),
              expectedBinarySha,
            );
            assert.strictEqual(yield* sha256File(chart), ChartSha256);
            const version = yield* runCommand([executable, "--version"]);
            assert.strictEqual(version.exitCode, 0, version.stderr);
            assert.match(version.stdout, /"version":\s*"1\.4\.1"/);
            assert.match(
              version.stdout,
              /"git_revision":\s*"163ea2146acb7b82082acea30ed691b29079095f"/,
            );

            const rendered = yield* runCommand([
              "helm",
              "template",
              "agentgateway-openai",
              chart,
              "--namespace",
              "agentos",
              "-f",
              valuesPath,
            ]);
            assert.strictEqual(rendered.exitCode, 0, rendered.stderr);
            const renderedDocuments = parseAllDocuments(rendered.stdout)
              .map((document) => recordOf(document.toJS()))
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
              [
                {
                  mountPath: "/var/run/secrets/agentos-provider/openai",
                  name: "provider-credential-openai",
                  readOnly: true,
                },
              ],
            );
            const providerVolumes = Array.isArray(podSpec.volumes)
              ? podSpec.volumes
              : [];
            assert.deepStrictEqual(
              providerVolumes.filter(
                (volume) =>
                  recordOf(volume).name === "provider-credential-openai",
              ),
              [
                {
                  name: "provider-credential-openai",
                  secret: {
                    defaultMode: 288,
                    items: [{ key: "token", path: "credential" }],
                    secretName: "agentgateway-ai-gateway-client",
                  },
                },
              ],
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
            const renderedCredential = path.join(
              root,
              "rendered-provider-credential",
            );
            yield* fs.writeFileString(
              renderedCredential,
              "conformance-only\n",
            );
            const validationConfig = typeof renderedConfig === "string"
              ? renderedConfig.replace(
                  "/var/run/secrets/agentos-provider/openai/credential",
                  renderedCredential,
                )
              : "";
            const renderedValidation = yield* runCommand(
              [
                executable,
                "--validate-only",
                "-c",
                validationConfig,
              ],
            );
            assert.strictEqual(
              renderedValidation.exitCode,
              0,
              renderedValidation.stderr,
            );

            const authorizationRequests: Array<{
              readonly authorization: string | null;
              readonly path: string;
            }> = [];
            const upstreamRequests: Array<{
              readonly authorization: string | null;
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
            let streamCancelled = false;
            let streamPulls = 0;
            let retryAttempts = 0;

            const authz = yield* acquireServer((request) => {
              const requestUrl = new URL(request.url);
              authorizationRequests.push({
                authorization: request.headers.get("authorization"),
                path: requestUrl.pathname,
              });
              if (request.headers.get("authorization") !== AllowedToken) {
                return new Response('{"error":"identity_denied"}', {
                  status: 403,
                  headers: {
                    "content-type": "application/json",
                    "x-agentos-error-kind": "identity_denied",
                  },
                });
              }
              return new Response(null, {
                status: 200,
                headers: { "x-agentos-subject": "mate-conformance" },
              });
            });

            const upstream = yield* acquireServer((request) => {
              const requestUrl = new URL(request.url);
              upstreamRequests.push({
                authorization: request.headers.get("authorization"),
                path: requestUrl.pathname,
                subject: request.headers.get("x-agentos-subject"),
              });
              if (requestUrl.pathname === "/stream") {
                const chunk = new Uint8Array(64 * 1024).fill(97);
                const body = new ReadableStream<Uint8Array>({
                  pull(controller) {
                    streamPulls += 1;
                    if (streamPulls >= 512) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(chunk);
                  },
                  cancel() {
                    streamCancelled = true;
                  },
                });
                return new Response(body, {
                  headers: { "content-type": "application/octet-stream" },
                });
              }
              if (requestUrl.pathname === "/provider-429") {
                return Response.json(
                  { error: { type: "rate_limit", message: "conformance" } },
                  { status: 429 },
                );
              }
              if (requestUrl.pathname === "/retry") {
                retryAttempts += 1;
                if (retryAttempts === 1) {
                  return Response.json(
                    { error: { type: "temporary" } },
                    { status: 503 },
                  );
                }
              }
              if (requestUrl.pathname === "/v1/responses/compact") {
                return Response.json({
                  type: "compaction",
                  encrypted_content: "opaque-agentos-compaction-artifact",
                });
              }
              if (requestUrl.pathname === "/v1/responses") {
                return Response.json(completedResponse());
              }
              return Response.json({
                path: requestUrl.pathname,
                authorization: request.headers.get("authorization"),
                subject: request.headers.get("x-agentos-subject"),
              });
            });

            const mcp = yield* acquireServer((request) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: () => request.json(),
                  catch: (cause) =>
                    ConformanceFailure.make({
                      operation: "decode_mcp_request",
                      message: String(cause),
                    }),
                }).pipe(
                  Effect.map((body) => {
                    const method = methodOf(body);
                    const result = modernMcpResult(method);
                    if (result === undefined) {
                      return Response.json({
                        jsonrpc: "2.0",
                        id: idOf(body),
                        error: { code: -32601, message: method },
                      });
                    }
                    return Response.json({
                      jsonrpc: "2.0",
                      id: idOf(body),
                      result,
                    });
                  }),
                ),
              ),
            );

            const telemetry = yield* acquireServer((request) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: () => request.arrayBuffer(),
                  catch: (cause) =>
                    ConformanceFailure.make({
                      operation: "read_otlp",
                      message: String(cause),
                    }),
                }).pipe(
                  Effect.map((body) => {
                    telemetryBodies.push(new Uint8Array(body));
                    return new Response(null, { status: 200 });
                  }),
                ),
              ),
            );
            const grpc = yield* acquireGrpcServer(grpcRequests);
            const oauth = yield* acquireServer((request) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: () => request.text(),
                  catch: (cause) =>
                    ConformanceFailure.make({
                      operation: "read_oauth_request",
                      message: String(cause),
                    }),
                }).pipe(
                  Effect.map((body) => {
                    oauthRequests.push({
                      authorization: request.headers.get("authorization"),
                      body,
                    });
                    return Response.json({
                      access_token: ExchangedToken,
                      expires_in: 60,
                      token_type: "Bearer",
                    });
                  }),
                ),
              ),
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
            const initialConfig = conformanceConfig({
              authzPort: authz.port,
              grpcPort: grpc.port,
              mcpPort: mcp.port,
              oauthPort: oauth.port,
              ports,
              upstreamPort: upstream.port,
            });
            yield* fs.writeFileString(configPath, initialConfig);

            const validation = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const child = Bun.spawn(
                  [executable, "--validate-only", "-f", configPath],
                  {
                    env: {
                      ...process.env,
                      CONFORMANCE_BACKEND_TOKEN: BackendToken,
                      CONFORMANCE_PROVIDER_TOKEN: ProviderToken,
                      CONFORMANCE_OAUTH_CLIENT_SECRET:
                        "conformance-client-secret",
                    },
                    stderr: "pipe",
                    stdout: "pipe",
                  },
                );
                return {
                  child,
                  stderr: new Response(child.stderr).text(),
                  stdout: new Response(child.stdout).text(),
                };
              }),
              ({ child }) =>
                Effect.sync(() => child.kill()).pipe(Effect.ignore),
            );
            const validationExit = yield* Effect.tryPromise({
              try: () => validation.child.exited,
              catch: (cause) =>
                ConformanceFailure.make({
                  operation: "validate_config",
                  message: String(cause),
                }),
            });
            assert.strictEqual(
              validationExit,
              0,
              `${yield* Effect.promise(() => validation.stdout)} ${yield* Effect.promise(() => validation.stderr)}`,
            );

            const gateway = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const child = Bun.spawn([executable, "-f", configPath], {
                  env: {
                    ...process.env,
                    CONFORMANCE_BACKEND_TOKEN: BackendToken,
                    CONFORMANCE_PROVIDER_TOKEN: ProviderToken,
                    CONFORMANCE_OAUTH_CLIENT_SECRET:
                      "conformance-client-secret",
                  },
                  stderr: "pipe",
                  stdout: "pipe",
                });
                return {
                  child,
                  stderr: new Response(child.stderr).text(),
                  stdout: new Response(child.stdout).text(),
                };
              }),
              ({ child }) =>
                Effect.sync(() => child.kill()).pipe(
                  Effect.andThen(
                    Effect.tryPromise({
                      try: () => child.exited,
                      catch: () => undefined,
                    }),
                  ),
                  Effect.ignore,
                ),
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
              authorization: `Bearer ${BackendToken}`,
              subject: "mate-conformance",
            });
            assert.strictEqual(
              authorizationRequests.at(-1)?.authorization,
              AllowedToken,
            );
            assert.strictEqual(
              upstreamRequests.at(-1)?.authorization,
              `Bearer ${BackendToken}`,
            );

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
            yield* Effect.sync(() =>
              process.stdout.write(
                `agentgateway_latency_ms ${JSON.stringify({
                  directP50: Number(directP50.toFixed(3)),
                  directP95: Number(percentile(directLatency, 0.95).toFixed(3)),
                  governedP50: Number(governedP50.toFixed(3)),
                  governedP95: Number(
                    percentile(governedLatency, 0.95).toFixed(3),
                  ),
                  medianDelta: Number((governedP50 - directP50).toFixed(3)),
                  samples: directLatency.length,
                })}\n`,
              ),
            );

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
            assert.strictEqual(retryAttempts, 2);

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
                body: JSON.stringify({
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
                body: JSON.stringify({
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
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/list",
                  params: { _meta: modernMeta },
                }),
              },
            );
            assert.strictEqual(mcpList.status, 200);
            assert.ok((yield* responseText(mcpList)).includes("echo"));

            const abort = new AbortController();
            const streamed = yield* fetchEffect(
              `http://127.0.0.1:${ports.gateway}/stream`,
              { headers: authorizedHeaders(), signal: abort.signal },
            );
            assert.strictEqual(streamed.status, 200);
            if (streamed.body === null) {
              return yield* ConformanceFailure.make({
                operation: "stream_response",
                message: "gateway returned no response body",
              });
            }
            const reader = streamed.body.getReader();
            const firstChunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (cause) =>
                ConformanceFailure.make({
                  operation: "read_stream",
                  message: String(cause),
                }),
            });
            assert.strictEqual(firstChunk.done, false);
            yield* Effect.sleep("100 millis");
            assert.ok(streamPulls < 512);
            abort.abort();
            yield* Effect.tryPromise({
              try: () => reader.cancel(),
              catch: () => undefined,
            });
            yield* eventually(
              "upstream_stream_cancellation",
              Effect.sync(() => streamCancelled),
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

            assert.strictEqual(gateway.child.killed, false);
          }),
        ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer))),
      ),
    60_000,
  );
});
