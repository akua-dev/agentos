import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { parse } from "yaml";

import {
  loadWorkloadClientProxyConfig,
  makeWorkloadClientProxyHandler,
  workloadClientProxyErrorResponse,
  workloadClientProxyReadinessResponse,
} from "../src/workload-client-proxy.ts";
import { responseFromUpstream } from "../src/workload-client-proxy-main.ts";

const suite = layer(BunServices.layer);
const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature";
const assignmentId = "20000000-0000-4000-8000-000000000001";

const HermesConfiguration = Schema.Struct({
  model: Schema.Struct({
    provider: Schema.String,
    default: Schema.String,
  }),
  providers: Schema.Struct({
    "agentos-gateway": Schema.Struct({
      name: Schema.String,
      api: Schema.String,
      api_key: Schema.String,
      transport: Schema.String,
      discover_models: Schema.Boolean,
      models: Schema.Array(Schema.String),
    }),
  }),
  agent: Schema.Struct({ api_max_retries: Schema.Number }),
  fallback_providers: Schema.Array(Schema.String),
  fallback_model: Schema.String,
});

function environment(values: Readonly<Record<string, string>>) {
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...values } }));
}

suite("Hermes Responses workload client proxy", (it) => {
  it.effect("resolves the pinned Hermes named provider fixture to an allowed Responses path", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtureUrl = new URL(
        "../../../docs/integrations/hermes-ai-gateway.config.yaml",
        import.meta.url,
      );
      const fixture = yield* fileSystem.readFileString(fixtureUrl.pathname);
      const parsedFixture = parse(fixture);
      const config = yield* Schema.decodeUnknownEffect(HermesConfiguration)(
        parsedFixture,
      );

      assert.strictEqual(config.model.provider, "custom:agentos-gateway");
      const provider = config.providers["agentos-gateway"];
      assert.strictEqual(provider.name, "AgentOS Gateway");
      assert.strictEqual(provider.transport, "codex_responses");
      assert.strictEqual(provider.api, "http://127.0.0.1:8790/v1");
      assert.strictEqual(
        provider.api_key,
        "agentos-workload-identity-placeholder",
      );
      assert.isFalse(provider.discover_models);
      assert.deepStrictEqual(provider.models, [config.model.default]);
      assert.strictEqual(config.agent.api_max_retries, 0);
      assert.deepStrictEqual(config.fallback_providers, []);
      assert.strictEqual(config.fallback_model, "");
      assert.isFalse(Object.prototype.hasOwnProperty.call(parsedFixture, "auxiliary"));

      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenPath = `${directory}/token`;
      yield* fileSystem.writeFileString(tokenPath, token);
      const forwarded = yield* Ref.make<Request | null>(null);
      const handler = yield* makeWorkloadClientProxyHandler({
        upstreamBaseUrl: new URL("http://agentgateway-openai.agentos.svc.cluster.local:8788"),
        tokenPath,
        forward: (request) =>
          Ref.set(forwarded, request).pipe(
            Effect.as(new Response(null, { status: 204 })),
          ),
      });

      const hermesResponsesUrl = `${
        provider.api.replace(/\/$/, "")
      }/responses`;
      const response = yield* handler(new Request(hermesResponsesUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${provider.api_key}` },
        body: JSON.stringify({ model: config.model.default }),
      }));
      const request = yield* Ref.get(forwarded);

      assert.strictEqual(response.status, 204);
      assert.strictEqual(
        request?.url,
        "http://agentgateway-openai.agentos.svc.cluster.local:8788/v1/responses",
      );
    }));

  it.effect("rereads identity, sanitizes authority headers, and injects only trusted assignment", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenPath = `${directory}/token`;
      yield* fileSystem.writeFileString(tokenPath, token);
      const requests = yield* Ref.make<ReadonlyArray<Request>>([]);
      const handler = yield* makeWorkloadClientProxyHandler({
        upstreamBaseUrl: new URL("http://agentgateway-openai.agentos.svc.cluster.local:8788"),
        tokenPath,
        assignmentId,
        forward: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as(new Response("provider failure", {
              status: 429,
              headers: { "x-upstream": "preserved" },
            })),
          ),
      });

      const first = yield* handler(new Request("http://127.0.0.1:8790/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer hermes-placeholder",
          "content-type": "application/json",
          "api-key": "caller-provider-secret",
          "x-api-key": "caller-provider-secret-2",
          "chatgpt-account-id": "caller-account",
          baggage: "caller-baggage",
          "x-ai-router-token": "caller-router-token",
          "x-codex-router-session": "caller-router-session",
          "x-ai-gateway-session": "caller-gateway-session",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-agentos-assignment-id": "forged-assignment",
          "x-agentos-decision": "forged-decision",
          "x-agentos-grant": "forged-grant",
          "x-ai-gateway-token": "legacy-shared-token",
        },
        body: "{\"model\":\"gpt-exact\"}",
      }));
      yield* fileSystem.writeFileString(tokenPath, `${token}a`);
      const second = yield* handler(new Request("http://127.0.0.1:8790/v1/responses/compact", {
        method: "POST",
        body: "{}",
      }));

      assert.strictEqual(first.status, 429);
      assert.strictEqual(first.headers.get("x-upstream"), "preserved");
      assert.strictEqual(yield* Effect.promise(() => first.text()), "provider failure");
      assert.strictEqual(second.status, 429);
      const forwarded = yield* Ref.get(requests);
      assert.lengthOf(forwarded, 2);
      assert.strictEqual(forwarded[0]?.headers.get("authorization"), `Bearer ${token}`);
      assert.strictEqual(forwarded[0]?.headers.get("x-agentos-assignment-id"), assignmentId);
      assert.isNull(forwarded[0]?.headers.get("x-agentos-decision"));
      assert.isNull(forwarded[0]?.headers.get("x-agentos-grant"));
      assert.isNull(forwarded[0]?.headers.get("x-ai-gateway-token"));
      assert.isNull(forwarded[0]?.headers.get("api-key"));
      assert.isNull(forwarded[0]?.headers.get("x-api-key"));
      assert.isNull(forwarded[0]?.headers.get("chatgpt-account-id"));
      assert.isNull(forwarded[0]?.headers.get("baggage"));
      assert.isNull(forwarded[0]?.headers.get("x-ai-router-token"));
      assert.isNull(forwarded[0]?.headers.get("x-codex-router-session"));
      assert.isNull(forwarded[0]?.headers.get("x-ai-gateway-session"));
      assert.strictEqual(
        forwarded[0]?.headers.get("traceparent"),
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      );
      assert.strictEqual(forwarded[1]?.headers.get("authorization"), `Bearer ${token}a`);
      assert.strictEqual(
        yield* Effect.promise(() => forwarded[0]?.text() ?? Promise.resolve("")),
        "{\"model\":\"gpt-exact\"}",
      );
    }));

  it.effect("hard-codes loopback listening and rejects invalid trusted assignment configuration", () =>
    Effect.gen(function*() {
      const config = yield* loadWorkloadClientProxyConfig().pipe(
        Effect.provide(environment({
          AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
          AI_GATEWAY_WORKLOAD_PROXY_HOST: "0.0.0.0",
          AGENTOS_ASSIGNMENT_ID: assignmentId,
        })),
      );
      assert.strictEqual(config.hostname, "127.0.0.1");
      assert.strictEqual(config.assignmentId, assignmentId);
      assert.strictEqual(config.idleTimeoutSeconds, 255);
      assert.strictEqual(config.gracefulShutdownMillis, 20_000);

      const configured = yield* loadWorkloadClientProxyConfig().pipe(
        Effect.provide(environment({
          AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
          AI_GATEWAY_IDLE_TIMEOUT_SECONDS: "120",
          AI_GATEWAY_GRACEFUL_SHUTDOWN_MILLIS: "45000",
        })),
      );
      assert.strictEqual(configured.idleTimeoutSeconds, 120);
      assert.strictEqual(configured.gracefulShutdownMillis, 45_000);

      for (const invalidUrl of [
        "ftp://agentgateway-openai.agentos.svc.cluster.local:8788",
        "http://agentgateway-github.agentos.svc.cluster.local:8788",
        "http://example.invalid:8788",
        "http://user:password@agentgateway-openai.agentos.svc.cluster.local:8788",
        "http://agentgateway-openai.agentos.svc.cluster.local:8788?trace=1",
        "http://agentgateway-openai.agentos.svc.cluster.local:8788#fragment",
        "http://agentgateway-openai.agentos.svc.cluster.local:8788/v1",
      ]) {
        const invalid = yield* loadWorkloadClientProxyConfig().pipe(
          Effect.provide(environment({ AI_GATEWAY_URL: invalidUrl })),
          Effect.flip,
        );
        assert.strictEqual(invalid.code, "invalid_configuration");
      }

      for (const invalidAssignmentId of [
        "caller-controlled-value",
        "20000000-0000-1000-8000-000000000001",
        "20000000-0000-4000-7000-000000000001",
      ]) {
        const invalid = yield* loadWorkloadClientProxyConfig().pipe(
          Effect.provide(environment({
            AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
            AGENTOS_ASSIGNMENT_ID: invalidAssignmentId,
          })),
          Effect.flip,
        );
        assert.strictEqual(invalid.code, "invalid_configuration");
      }
    }));

  it.effect("strips hop-by-hop response headers while preserving provider data", () =>
    Effect.gen(function*() {
      const response = yield* responseFromUpstream({
        status: 429,
        headers: {
          connection: "keep-alive, x-connection-hop",
          "keep-alive": "timeout=5",
          "proxy-authenticate": "Basic",
          "proxy-authorization": "Basic secret",
          te: "trailers",
          trailer: "x-trailer",
          "transfer-encoding": "chunked",
          upgrade: "websocket",
          "x-connection-hop": "private",
          "x-provider-request-id": "provider-1",
        },
        body: Stream.succeed(new TextEncoder().encode("provider-body")),
      });

      assert.strictEqual(response.status, 429);
      for (const name of [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-connection-hop",
      ]) {
        assert.isNull(response.headers.get(name));
      }
      assert.strictEqual(
        response.headers.get("x-provider-request-id"),
        "provider-1",
      );
      assert.strictEqual(
        yield* Effect.promise(() => response.text()),
        "provider-body",
      );
    }));

  it.effect("preserves a 205 response without constructing a body", () =>
    Effect.gen(function*() {
      const response = yield* responseFromUpstream({
        status: 205,
        headers: { "content-type": "text/plain" },
        body: Stream.succeed(new TextEncoder().encode("invalid-body")),
      });

      assert.strictEqual(response.status, 205);
      assert.isNull(response.body);
      assert.strictEqual(
        yield* Effect.promise(() => response.text()),
        "",
      );
    }));

  it.effect("preserves upstream response streams across a long gap", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenPath = `${directory}/token`;
      yield* fileSystem.writeFileString(tokenPath, token);
      const handler = yield* makeWorkloadClientProxyHandler({
        upstreamBaseUrl: new URL("http://agentgateway-openai.agentos.svc.cluster.local:8788"),
        tokenPath,
        forward: () => Stream.toReadableStreamEffect(Stream.concat(
          Stream.succeed(new TextEncoder().encode("first")),
          Stream.fromEffect(
            Effect.sleep("1.1 seconds").pipe(
              Effect.andThen(Effect.succeed(new TextEncoder().encode("second"))),
            ),
          ),
        )).pipe(
          Effect.map((body) => new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
          })),
        ),
      });

      const response = yield* TestClock.withLive(handler(new Request(
        "http://127.0.0.1:8790/v1/responses",
        { method: "POST" },
      )));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        yield* TestClock.withLive(Effect.promise(() => response.text())),
        "firstsecond",
      );
    }));

  it.effect("reports readiness only for a bounded, trimmed, UTF-8 JWT-like token", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenPath = `${directory}/token`;

      const missing = yield* workloadClientProxyReadinessResponse(tokenPath);
      assert.strictEqual(missing.status, 503);

      const invalidTokens: ReadonlyArray<Uint8Array> = [
        new Uint8Array(),
        new TextEncoder().encode(`${token}\n`),
        new TextEncoder().encode("not-a-jwt"),
        new Uint8Array([0xff, 0xfe, 0xfd]),
        new Uint8Array(16 * 1024 + 1).fill(97),
      ];
      for (const bytes of invalidTokens) {
        yield* fileSystem.writeFile(tokenPath, bytes);
        const response = yield* workloadClientProxyReadinessResponse(tokenPath);
        assert.strictEqual(response.status, 503);
      }

      yield* fileSystem.writeFileString(tokenPath, token);
      const ready = yield* workloadClientProxyReadinessResponse(tokenPath);
      assert.strictEqual(ready.status, 200);
      assert.deepStrictEqual(yield* Effect.promise(() => ready.json()), {
        status: "ready",
      });
    }));

  it.effect("fails closed without sending unsupported, unauthenticated, or readiness requests", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenPath = `${directory}/token`;
      const calls = yield* Ref.make(0);
      const handler = yield* makeWorkloadClientProxyHandler({
        upstreamBaseUrl: new URL("http://agentgateway-openai.agentos.svc.cluster.local:8788"),
        tokenPath,
        forward: () => Ref.update(calls, (value) => value + 1).pipe(
          Effect.as(new Response(null, { status: 200 })),
        ),
      });

      const unsupported = yield* handler(new Request("http://127.0.0.1:8790/v1/chat/completions", {
        method: "POST",
      })).pipe(Effect.flip);
      assert.strictEqual(unsupported.code, "invalid_request");
      assert.strictEqual(workloadClientProxyErrorResponse(unsupported).status, 404);

      const missing = yield* handler(new Request("http://127.0.0.1:8790/v1/responses", {
        method: "POST",
      })).pipe(Effect.flip);
      assert.strictEqual(missing.code, "token_unavailable");
      assert.strictEqual(workloadClientProxyErrorResponse(missing).status, 503);
      yield* workloadClientProxyReadinessResponse(tokenPath);
      assert.strictEqual(yield* Ref.get(calls), 0);
    }));
});
