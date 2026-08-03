import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AgentGatewayReadinessCheck,
  AgentGatewayProbeError,
  hasSynchronizedConfiguration,
  makeAgentGatewayReadinessRequestHandler,
  probeAgentGateway,
} from "../src/readiness.ts";

const limits = { readinessTimeoutMillis: 50 };

const handler = (check: Effect.Effect<boolean, unknown>) =>
  makeAgentGatewayReadinessRequestHandler(limits).pipe(
    Effect.provide(Layer.succeed(AgentGatewayReadinessCheck, { check })),
    Effect.provide(BunServices.layer),
  );

function clientLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      execute(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      )
    ),
  );
}

const probe = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.scoped(probeAgentGateway(client, {
    readinessUrl: new URL("http://127.0.0.1:15021/healthz/ready"),
    metricsUrl: new URL("http://127.0.0.1:15020/metrics"),
    maximumMetricsBytes: 64,
  }));
});

describe("agentgateway semantic readiness", () => {
  it.effect("accepts only an unambiguous synchronized configuration metric", () =>
    Effect.sync(() => {
      assert.isTrue(
        hasSynchronizedConfiguration(
          "# HELP config_synchronized reload state\nconfig_synchronized 1\n",
        ),
      );
      assert.isTrue(
        hasSynchronizedConfiguration(
          'agentgateway_config_synchronized{gateway="openai"} 1.0 1780000000\n',
        ),
      );
      assert.isFalse(
        hasSynchronizedConfiguration(
          "config_synchronized 1\nconfig_synchronized 0\n",
        ),
      );
      assert.isFalse(hasSynchronizedConfiguration("config_synchronized 0\n"));
      assert.isFalse(hasSynchronizedConfiguration("unrelated_metric 1\n"));
    }));

  it.effect("separates process liveness from semantic readiness", () =>
    Effect.gen(function*() {
      const healthy = yield* handler(Effect.succeed(true));
      assert.strictEqual(
        (yield* healthy(new Request("http://probe.test/livez"))).status,
        200,
      );
      assert.strictEqual(
        (yield* healthy(new Request("http://probe.test/readyz"))).status,
        200,
      );

      const unavailable = yield* handler(Effect.fail("dependency_unavailable"));
      const response = yield* unavailable(
        new Request("http://probe.test/readyz"),
      );
      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        status: "not_ready",
      });
      assert.strictEqual(
        (yield* unavailable(new Request("http://probe.test/livez"))).status,
        200,
      );
    }));

  it.effect("requires native health and a bounded synchronized metric", () =>
    Effect.gen(function*() {
      const ready = yield* probe.pipe(Effect.provide(clientLayer((request) =>
        Effect.succeed(
          request.url.includes(":15020/")
            ? new Response("agentgateway_config_synchronized 1\n")
            : new Response(null, { status: 200 }),
        )
      )));
      assert.isTrue(ready);

      const nativeFailure = yield* probe.pipe(Effect.provide(clientLayer(() =>
        Effect.succeed(new Response(null, { status: 503 }))
      )));
      assert.isFalse(nativeFailure);

      const oversized = yield* probe.pipe(
        Effect.provide(clientLayer((request) =>
          Effect.succeed(
            request.url.includes(":15020/")
              ? new Response("x".repeat(65))
              : new Response(null, { status: 200 }),
          )
        )),
        Effect.flip,
      );
      assert.instanceOf(oversized, AgentGatewayProbeError);
      assert.strictEqual(oversized.code, "response_too_large");
    }));

  it.effect("rejects unsupported methods and paths without running the probe", () =>
    Effect.gen(function*() {
      const readiness = yield* handler(Effect.die("must not run"));
      assert.strictEqual(
        (yield* readiness(new Request("http://probe.test/readyz", {
          method: "POST",
        }))).status,
        405,
      );
      assert.strictEqual(
        (yield* readiness(new Request("http://probe.test/unknown"))).status,
        404,
      );
    }));

  it.effect("ships the Effect sidecar and its dependencies in the AgentOS image", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const repository = yield* paths.fromFileUrl(
        new URL("../../..", import.meta.url),
      );
      const dockerfile = yield* fileSystem.readFileString(
        paths.join(repository, "Dockerfile"),
      );
      for (const required of [
        "--filter @agentos/agentgateway",
        "/tmp/agentos-dependencies/services/agentgateway/node_modules/",
        "/opt/agentos/services/agentgateway/src/readiness-main.ts",
        "/usr/local/bin/agentos-agentgateway-readiness",
      ]) {
        assert.include(dockerfile, required);
      }
    }).pipe(Effect.provide(BunServices.layer)));
});
