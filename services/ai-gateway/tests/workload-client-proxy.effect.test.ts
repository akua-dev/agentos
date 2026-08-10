import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Ref, Schema } from "effect";
import { parse } from "yaml";

import {
  loadWorkloadClientProxyConfig,
  makeWorkloadClientProxyHandler,
  workloadClientProxyErrorResponse,
  workloadClientProxyReadinessResponse,
} from "../src/workload-client-proxy.ts";

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
      const config = yield* Schema.decodeUnknownEffect(HermesConfiguration)(
        parse(fixture),
      );

      assert.strictEqual(config.model.provider, "agentos-gateway");
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
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-agentos-assignment-id": "forged-assignment",
          "x-agentos-decision": "forged-decision",
          "x-agentos-grant": "forged-grant",
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
