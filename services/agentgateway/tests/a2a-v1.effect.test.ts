import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { assert, describe, layer } from "@effect/vitest";
import {
  Clock,
  Config,
  Console,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { TestClock } from "effect/testing";
import { stringify } from "yaml";

import { compileA2aDeliveryRequest } from "../../../packages/agentos/src/protocol/a2a.ts";

const AgentgatewayVersion = "1.4.1";
const AgentgatewayCommit = "163ea2146acb7b82082acea30ed691b29079095f";
const AgentgatewayDarwinArm64Sha256 =
  "f0fdc496b6dfd23f740bf458ff3a80c4453d7fd2397f0851bb42c5e00b6841d7";
const AgentgatewayLinuxAmd64Sha256 =
  "20f7b298e0c36eef33e7d612b0d0b91d87d43124f59b01f6e9b730477f66d982";
const AgentgatewayLinuxArm64Sha256 =
  "983a0919e30d287ec34ba51a69aa678fb81c5b893a59ae267b29d9fd30365d0e";
const CallerToken = "Bearer projected-caller-service-account-token";
const TargetAgentId = "22222222-2222-4222-8222-222222222222";
const InboxId = "44444444-4444-4444-8444-444444444444";
const TaskId = "55555555-5555-4555-8555-555555555555";
const AssignmentId = "66666666-6666-4666-8666-666666666666";

class A2aConformanceFailure extends Schema.TaggedErrorClass<A2aConformanceFailure>()(
  "A2aConformanceFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const VersionOutputSchema = Schema.fromJsonString(Schema.Struct({
  version: Schema.String,
  git_revision: Schema.String,
  build_target: Schema.String,
}));
const AgentCardSchema = Schema.fromJsonString(Schema.Struct({
  supportedInterfaces: Schema.Array(Schema.Struct({
    url: Schema.String,
    protocolBinding: Schema.String,
    protocolVersion: Schema.String,
  })),
  skills: Schema.Array(Schema.Struct({ id: Schema.String })),
}));
const JsonRpcResponseSchema = Schema.fromJsonString(Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  result: Schema.Struct({
    task: Schema.Struct({
      id: Schema.String,
      contextId: Schema.String,
      status: Schema.Struct({ state: Schema.String }),
    }),
    observed: Schema.Struct({
      a2aVersion: Schema.NullOr(Schema.String),
      authorization: Schema.NullOr(Schema.String),
      subject: Schema.NullOr(Schema.String),
    }),
  }),
}));
const MetricsFileSchema = Schema.fromJsonString(Schema.Struct({
  event: Schema.Literal("agentos.a2a.conformance.overhead"),
  samples: Schema.Number,
  directP50Millis: Schema.Number,
  directP95Millis: Schema.Number,
  gatewayP50Millis: Schema.Number,
  gatewayP95Millis: Schema.Number,
  addedP50Millis: Schema.Number,
  addedP95Millis: Schema.Number,
}));

function acquireWebServer(
  handler: (request: Request) => Response,
) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler }),
      catch: (cause) =>
        failure("start_test_server", cause),
    }).pipe(
      Effect.flatMap((server) => {
        const port = server.port;
        if (port !== undefined) return Effect.succeed({ port, server });
        return Effect.sync(() => server.stop(true)).pipe(
          Effect.andThen(
            Effect.fail(failure("start_test_server", "server allocated no port")),
          ),
        );
      }),
    ),
    ({ server }) => Effect.sync(() => server.stop(true)),
  );
}

const allocatePort = Effect.fn("agentos.a2aConformance.allocatePort")(
  function*() {
    const server = yield* Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(null, { status: 204 }),
        }),
      catch: (cause) => failure("allocate_port", cause),
    });
    const port = server.port;
    yield* Effect.sync(() => server.stop(true));
    if (port !== undefined) return port;
    return yield* failure("allocate_port", "server allocated no port");
  },
);

function authorizationServer(request: Request) {
  if (request.headers.get("authorization") !== CallerToken) {
    return Response.json({ error: "identity_denied" }, { status: 403 });
  }
  return new Response(null, {
    status: 200,
    headers: { "x-agentos-subject": "mate:caller" },
  });
}

function a2aBackend(request: Request) {
  const path = URL.parse(request.url)?.pathname ?? "/";
  if (path.endsWith("/.well-known/agent-card.json")) {
    return Response.json({
      name: "platform-mate",
      description: "Reviewed platform domain",
      supportedInterfaces: [
        {
          url: "http://backend.internal/a2a/jsonrpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      version: "2026.08.01",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: true,
      },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: [
        "application/vnd.agentos.inbox-reference+json",
      ],
      defaultOutputModes: [
        "application/vnd.agentos.inbox-reference+json",
      ],
      skills: [{
        id: "repository.implementation@v1",
        name: "Repository implementation",
        description: "Implements reviewed repository changes",
        tags: ["repository", "implementation"],
      }],
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id: `agentos:inbox:${InboxId}`,
    result: {
      task: {
        id: `agentos:delivery:${InboxId}`,
        contextId: `agentos:task:${TaskId}`,
        status: { state: "TASK_STATE_SUBMITTED" },
      },
      observed: {
        a2aVersion: request.headers.get("a2a-version"),
        authorization: request.headers.get("authorization"),
        subject: request.headers.get("x-agentos-subject"),
      },
    },
  });
}

function agentgatewayConfig(options: {
  readonly authorizationPort: number;
  readonly backendPort: number;
  readonly gatewayPort: number;
  readonly readinessPort: number;
}) {
  return stringify({
    config: {
      logging: { format: "json" },
      readinessAddr: `127.0.0.1:${options.readinessPort}`,
    },
    binds: [{
      port: options.gatewayPort,
      listeners: [{
        routes: [{
          policies: {
            a2a: {},
            extAuthz: {
              host: `127.0.0.1:${options.authorizationPort}`,
              failureMode: "deny",
              includeRequestHeaders: ["authorization"],
              protocol: {
                http: {
                  path: '"/authorize"',
                  includeResponseHeaders: ["x-agentos-subject"],
                },
              },
            },
          },
          backends: [{ host: `127.0.0.1:${options.backendPort}` }],
        }],
      }],
    }],
  });
}

function httpText(request: HttpClientRequest.HttpClientRequest) {
  return Effect.scoped(Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) => failure("http_request", cause)),
    );
    const body = yield* response.text.pipe(
      Effect.mapError((cause) => failure("read_response", cause)),
    );
    return { body, status: response.status };
  }));
}

const waitUntilReady = Effect.fn("agentos.a2aConformance.waitUntilReady")(
  function*(port: number) {
    const startedAt = yield* Clock.currentTimeMillis;
    while ((yield* Clock.currentTimeMillis) - startedAt < 10_000) {
      const response = yield* Effect.option(
        httpText(
          HttpClientRequest.get(
            `http://127.0.0.1:${port}/healthz/ready`,
          ),
        ),
      );
      if (Option.isSome(response) && response.value.status === 200) return;
      yield* Effect.sleep("25 millis");
    }
    return yield* failure(
      "gateway_readiness",
      "agentgateway did not become ready within 10 seconds",
    );
  },
);

function percentile(samples: ReadonlyArray<number>, quantile: number) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

const timedGet = Effect.fn("agentos.a2aConformance.timedGet")(
  function*(url: string, authorization?: string) {
    const request = authorization === undefined
      ? HttpClientRequest.get(url)
      : HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("authorization", authorization),
      );
    const start = yield* Effect.sync(() => performance.now());
    const response = yield* httpText(request);
    const end = yield* Effect.sync(() => performance.now());
    if (response.status !== 200) {
      return yield* failure("timed_request", `unexpected status ${response.status}`);
    }
    return end - start;
  },
);

const conformance = Effect.gen(function*() {
  const executableOption = yield* Config.option(
    Config.string("AGENTOS_AGENTGATEWAY_BIN"),
  );
  if (Option.isNone(executableOption)) {
    yield* Console.log(
      "A2A live conformance skipped: AGENTOS_AGENTGATEWAY_BIN is unset",
    );
    return;
  }

  const executable = executableOption.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionProcess = yield* ChildProcess.make(executable, ["--version"], {
    stderr: "pipe",
    stdout: "pipe",
  }).pipe(
    Effect.mapError((cause) => failure("read_version", cause)),
  );
  const versionOutput = yield* versionProcess.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(() => "", (all, chunk) => all + chunk),
    Effect.mapError((cause) => failure("read_version", cause)),
  );
  assert.strictEqual(Number(yield* versionProcess.exitCode), 0);
  const version = yield* Schema.decodeUnknownEffect(VersionOutputSchema)(
    versionOutput,
  ).pipe(Effect.mapError((cause) => failure("decode_version", cause)));
  assert.strictEqual(version.version, AgentgatewayVersion);
  assert.strictEqual(version.git_revision, AgentgatewayCommit);
  const expectedDigest = expectedBinaryDigest(version.build_target);
  if (expectedDigest === null) {
    return yield* failure(
      "unsupported_binary_target",
      `unsupported agentgateway target ${version.build_target}`,
    );
  }
  const crypto = yield* Crypto.Crypto;
  const binaryDigest = yield* fs.readFile(executable).pipe(
    Effect.flatMap((bytes) => crypto.digest("SHA-256", bytes)),
    Effect.map(Encoding.encodeHex),
    Effect.mapError((cause) => failure("hash_binary", cause)),
  );
  assert.strictEqual(binaryDigest, expectedDigest);

  yield* Effect.scoped(Effect.gen(function*() {
    const authorization = yield* acquireWebServer(authorizationServer);
    const backend = yield* acquireWebServer(a2aBackend);
    const gatewayPort = yield* allocatePort();
    const readinessPort = yield* allocatePort();
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "agentos-a2a-conformance-",
    });
    const configPath = path.join(root, "config.yaml");
    yield* fs.writeFileString(configPath, agentgatewayConfig({
      authorizationPort: authorization.port,
      backendPort: backend.port,
      gatewayPort,
      readinessPort,
    }));

    const gateway = yield* ChildProcess.make(
      executable,
      ["-f", configPath],
      {
        forceKillAfter: "1 second",
        killSignal: "SIGTERM",
        stderr: "pipe",
        stdout: "pipe",
      },
    ).pipe(Effect.mapError((cause) => failure("start_gateway", cause)));
    yield* gateway.all.pipe(Stream.runDrain, Effect.forkScoped);
    yield* waitUntilReady(readinessPort);

    const cardPath =
      `/agents/${TargetAgentId}/.well-known/agent-card.json`;
    const denied = yield* httpText(
      HttpClientRequest.get(`http://127.0.0.1:${gatewayPort}${cardPath}`),
    );
    assert.strictEqual(denied.status, 403);

    const cardResponse = yield* httpText(
      HttpClientRequest.get(
        `http://127.0.0.1:${gatewayPort}${cardPath}`,
      ).pipe(HttpClientRequest.setHeader("authorization", CallerToken)),
    );
    assert.strictEqual(cardResponse.status, 200);
    const card = yield* Schema.decodeUnknownEffect(AgentCardSchema)(
      cardResponse.body,
    ).pipe(Effect.mapError((cause) => failure("decode_agent_card", cause)));
    assert.deepStrictEqual(card.supportedInterfaces, [{
      url:
        `http://127.0.0.1:${gatewayPort}/agents/${TargetAgentId}/a2a/jsonrpc`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }]);
    assert.deepStrictEqual(card.skills, [
      { id: "repository.implementation@v1" },
    ]);

    const compiled = yield* compileA2aDeliveryRequest({
      version: 1,
      authoritative: {
        inboxId: InboxId,
        taskId: TaskId,
        assignmentId: AssignmentId,
        status: "committed",
        committedAtMillis: 1_785_638_400_000,
      },
      callerAgentId: "11111111-1111-4111-8111-111111111111",
      targetAgentId: TargetAgentId,
      edge: "direct_parent_child",
      speechAct: "request",
      skillId: "repository.implementation@v1",
      subject: "Implement the reviewed repository change",
      authorization: {
        identity: "authenticated",
        caller: "allowed",
        target: "allowed",
        skill: "allowed",
        hierarchyEdge: "allowed",
        assignment: "allowed",
      },
    });
    const requestWithBody = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `http://127.0.0.1:${gatewayPort}/agents/${TargetAgentId}/a2a/jsonrpc`,
      ).pipe(
        HttpClientRequest.setHeader("authorization", CallerToken),
        HttpClientRequest.setHeader("a2a-version", "1.0"),
      ),
      compiled.body,
    ).pipe(Effect.mapError((cause) => failure("encode_request", cause)));
    const deliveryResponse = yield* httpText(requestWithBody);
    assert.strictEqual(deliveryResponse.status, 200);
    const response = yield* Schema.decodeUnknownEffect(JsonRpcResponseSchema)(
      deliveryResponse.body,
    ).pipe(Effect.mapError((cause) => failure("decode_delivery", cause)));
    assert.deepStrictEqual(response.result, {
      task: {
        id: `agentos:delivery:${InboxId}`,
        contextId: `agentos:task:${TaskId}`,
        status: { state: "TASK_STATE_SUBMITTED" },
      },
      observed: {
        a2aVersion: "1.0",
        authorization: CallerToken,
        subject: "mate:caller",
      },
    });

    const directUrl = `http://127.0.0.1:${backend.port}/probe`;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}/probe`;
    yield* Effect.forEach(
      Array.from({ length: 5 }),
      () => Effect.all([
        timedGet(directUrl),
        timedGet(gatewayUrl, CallerToken),
      ]),
      { discard: true },
    );
    const directSamples = yield* Effect.forEach(
      Array.from({ length: 50 }),
      () => timedGet(directUrl),
    );
    const gatewaySamples = yield* Effect.forEach(
      Array.from({ length: 50 }),
      () => timedGet(gatewayUrl, CallerToken),
    );
    const metrics: typeof MetricsFileSchema.Type = {
      event: "agentos.a2a.conformance.overhead",
      samples: 50,
      directP50Millis: percentile(directSamples, 0.5),
      directP95Millis: percentile(directSamples, 0.95),
      gatewayP50Millis: percentile(gatewaySamples, 0.5),
      gatewayP95Millis: percentile(gatewaySamples, 0.95),
      addedP50Millis:
        percentile(gatewaySamples, 0.5) - percentile(directSamples, 0.5),
      addedP95Millis:
        percentile(gatewaySamples, 0.95) - percentile(directSamples, 0.95),
    };
    const metricsPath = yield* Config.option(
      Config.string("AGENTOS_A2A_METRICS_PATH"),
    );
    if (Option.isSome(metricsPath)) {
      const encoded = yield* Schema.encodeEffect(MetricsFileSchema)(
        metrics,
      ).pipe(Effect.mapError((cause) => failure("encode_metrics", cause)));
      yield* fs.writeFileString(metricsPath.value, encoded);
    }
  }));
});

describe("agentgateway 1.4.1 A2A v1 live conformance", () => {
  layer(Layer.merge(BunServices.layer, BunHttpClient.layer))((it) => {
    it.effect(
      "routes v1 Agent Cards and reference delivery through external authorization",
      () => TestClock.withLive(conformance),
      60_000,
    );
  });
});

function failure(operation: string, cause: unknown) {
  return A2aConformanceFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function expectedBinaryDigest(buildTarget: string): string | null {
  switch (buildTarget) {
    case "aarch64-apple-darwin":
      return AgentgatewayDarwinArm64Sha256;
    case "x86_64-unknown-linux-gnu":
      return AgentgatewayLinuxAmd64Sha256;
    case "aarch64-unknown-linux-gnu":
      return AgentgatewayLinuxArm64Sha256;
    default:
      return null;
  }
}
