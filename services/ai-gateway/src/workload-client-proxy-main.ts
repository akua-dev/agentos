#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Stream,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  AIProviderHttp,
  AIProviderHttpLive,
  AIProviderHttpRequestInit,
  type AIProviderResponse,
} from "./provider-http.ts";
import {
  loadWorkloadClientProxyConfig,
  makeWorkloadClientProxyHandler,
  workloadClientProxyReadinessResponse,
  workloadClientProxyErrorResponse,
  WorkloadClientProxyError,
} from "./workload-client-proxy.ts";

const hopByHopResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const httpToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function responseHeaders(upstream: AIProviderResponse) {
  const headers = new Headers(upstream.headers);
  const connection = headers.get("connection");
  headers.delete("connection");
  for (const name of connection?.split(",") ?? []) {
    const normalized = name.trim().toLowerCase();
    if (httpToken.test(normalized)) headers.delete(normalized);
  }
  for (const name of hopByHopResponseHeaders) headers.delete(name);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return headers;
}

export function responseFromUpstream(
  upstream: AIProviderResponse,
) {
  return Effect.gen(function*() {
    const headers = responseHeaders(upstream);
    if (upstream.body === null) {
      return new Response(null, { status: upstream.status, headers });
    }
    const body = yield* Stream.toReadableStreamEffect(upstream.body);
    return new Response(body, { status: upstream.status, headers });
  });
}

const startup = Effect.gen(function*() {
  const config = yield* loadWorkloadClientProxyConfig();
  const http = yield* AIProviderHttp;
  const handler = yield* makeWorkloadClientProxyHandler({
    upstreamBaseUrl: config.upstreamBaseUrl,
    tokenPath: config.tokenPath,
    assignmentId: config.assignmentId,
    forward: (request) =>
      http.execute(request).pipe(
        Effect.mapError(() =>
          WorkloadClientProxyError.make({ code: "upstream_unavailable" })
        ),
        Effect.flatMap(responseFromUpstream),
      ),
  });
  const routes = Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add("GET", "/livez", () =>
      Effect.succeed(HttpServerResponse.fromWeb(Response.json({ status: "alive" }))));
    yield* router.add("GET", "/readyz", () =>
      workloadClientProxyReadinessResponse(config.tokenPath).pipe(
        Effect.map(HttpServerResponse.fromWeb),
      ));
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap(handler),
        Effect.catchTag("WorkloadClientProxyError", (error) =>
          Effect.succeed(workloadClientProxyErrorResponse(error))),
        Effect.catch(() =>
          Effect.succeed(Response.json({ error: "proxy_unavailable" }, {
            status: 503,
          }))
        ),
        Effect.map(HttpServerResponse.fromWeb),
      ));
  }));
  const server = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
    Layer.provide(BunHttpServer.layer({
      hostname: config.hostname,
      port: config.port,
      idleTimeout: config.idleTimeoutSeconds,
      gracefulShutdownTimeout: config.gracefulShutdownMillis,
    })),
  );
  yield* Console.log(JSON.stringify({
    event: "agentos.ai_gateway_workload_proxy.listening",
    hostname: config.hostname,
    port: config.port,
  }));
  return yield* Layer.launch(server);
});

if (import.meta.main) {
  const aiProviderHttpClientLayer = BunHttpClient.layer.pipe(
    Layer.provide(AIProviderHttpRequestInit),
  );
  const platform = Layer.mergeAll(
    BunFileSystem.layer,
    aiProviderHttpClientLayer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
    AIProviderHttpLive.pipe(Layer.provide(aiProviderHttpClientLayer)),
  );
  BunRuntime.runMain(startup.pipe(
    Effect.tapError(() =>
      Console.error(JSON.stringify({
        event: "agentos.ai_gateway_workload_proxy.failed",
      }))
    ),
    Effect.provide(platform),
  ), { disableErrorReporting: true });
}
