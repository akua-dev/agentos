import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric, Ref, Tracer } from "effect";

import {
  AIGatewayTelemetry,
  makeAIGatewayTelemetry,
  noopAIGatewayTelemetry,
} from "../src/observability.ts";

function runWithNativeTelemetry<A, E, R>(
  effect: (
    telemetry: AIGatewayTelemetry["Service"],
    spans: Array<Tracer.NativeSpan>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function*() {
    const ids = yield* Ref.make(0);
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const telemetry = yield* makeAIGatewayTelemetry({
      nextId: Ref.getAndUpdate(ids, (value) => value + 1).pipe(
        Effect.map((value) => `gateway-${value + 1}`),
      ),
    });
    return yield* effect(telemetry, spans).pipe(Effect.withTracer(tracer));
  }).pipe(Effect.provide(BunCryptoLayer));
}

describe("native Effect AI Gateway telemetry", () => {
  it.effect("uses Effect spans and metrics for the complete bounded lifecycle", () =>
    runWithNativeTelemetry((telemetry, spans) =>
      Effect.gen(function*() {
        const request = yield* telemetry.start(
          new Request("http://ai-gateway.test/v1/responses", {
            method: "POST",
            headers: {
              traceparent:
                "00-11111111111111111111111111111111-2222222222222222-01",
              tracestate:
                "vendor=safe, 1tenant@system=value with internal space",
              "x-agentos-runtime": "pi",
              "x-agentos-stream-mode": "streaming",
            },
          }),
        );
        const upstreamHeaders = new Headers();
        yield* request.authenticate(true);
        yield* request.routeStarted;
        yield* request.routeEnded("acquired");
        yield* request.quotaRefresh("fresh");
        yield* request.quotaObservation(1.25, false);
        yield* request.upstreamStarted(upstreamHeaders);
        yield* request.upstreamHeaders(
          200,
          new Headers({ "x-request-id": "req_safe_provider_1" }),
        );
        yield* request.streamChunk(11);
        yield* request.streamChunk(13);
        yield* request.routeReleaseStarted;
        yield* request.routeReleased;
        yield* request.end({ status: 200, streamOutcome: "completed" });

        assert.strictEqual(
          upstreamHeaders.get("x-client-request-id"),
          "gateway-2",
        );
        assert.match(
          upstreamHeaders.get("traceparent") ?? "",
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        );
        assert.strictEqual(
          upstreamHeaders.get("tracestate"),
          "vendor=safe, 1tenant@system=value with internal space",
        );
        assert.deepStrictEqual(spans.map(({ name }) => name), [
          "ai-gateway.request",
          "ai-gateway.authenticate",
          "ai-gateway.route.acquire",
          "ai-gateway.quota.refresh",
          "ai-gateway.upstream",
          "ai-gateway.stream",
          "ai-gateway.route.release",
        ]);
        const requestSpan = spans[0];
        const upstreamSpan = spans.find(({ name }) =>
          name === "ai-gateway.upstream"
        );
        assert.strictEqual(requestSpan?.traceId, "11111111111111111111111111111111");
        assert.strictEqual(
          requestSpan?.attributes.get("agentos.access.route"),
          "openai_responses",
        );
        assert.strictEqual(
          requestSpan?.attributes.get("agentos.access.adapter"),
          "ai_gateway",
        );
        assert.strictEqual(
          requestSpan?.attributes.get("agentos.access.credential.outcome"),
          "released",
        );
        assert.strictEqual(
          requestSpan?.attributes.get("agentos.access.provider.outcome"),
          "completed",
        );
        assert.strictEqual(upstreamSpan?.traceId, requestSpan?.traceId);
        assert.strictEqual(
          upstreamSpan?.attributes.get("agentos.ai.provider.request_id"),
          "req_safe_provider_1",
        );
        const streamSpan = spans.find(({ name }) =>
          name === "ai-gateway.stream"
        );
        assert.strictEqual(
          streamSpan?.attributes.get("agentos.ai.stream.chunks"),
          2,
          JSON.stringify(Object.fromEntries(streamSpan?.attributes ?? [])),
        );

        const metrics = yield* Metric.snapshot;
        for (const name of [
          "agentos.ai.operations",
          "agentos.ai.provider.attempts",
          "agentos.ai.route.events",
          "agentos.ai.route.reservations.active",
          "agentos.ai.quota.refreshes",
          "agentos.ai.streams",
          "agentos.ai.streams.active",
          "agentos.ai.stream.chunks",
          "agentos.ai.stream.bytes",
          "agentos.access.credential.releases",
          "agentos.access.provider.operations",
        ]) {
          assert.isDefined(metrics.find(({ id }) => id === name), name);
        }
        const active = metrics.filter(({ id }) =>
          id === "agentos.ai.streams.active" ||
          id === "agentos.ai.route.reservations.active"
        );
        assert.lengthOf(active, 2);
        for (const metric of active) {
          assert.strictEqual(
            "count" in metric.state ? metric.state.count : undefined,
            0,
          );
        }
      })
    ));

  it.effect("contains tracer defects and leaves upstream headers untouched", () =>
    Effect.gen(function*() {
      const telemetry = yield* makeAIGatewayTelemetry();
      const defective = Tracer.make({
        span(options) {
          const revoked = Proxy.revocable<Tracer.Span>(
            new Tracer.NativeSpan(options),
            {},
          );
          revoked.revoke();
          return revoked.proxy;
        },
      });
      const request = yield* telemetry.start(
        new Request("http://ai-gateway.test/v1/responses"),
      ).pipe(Effect.withTracer(defective));
      const headers = new Headers();
      yield* request.upstreamStarted(headers).pipe(Effect.withTracer(defective));
      yield* request.end({
        error: new Error("private provider payload"),
        streamOutcome: "upstream_error",
      }).pipe(Effect.withTracer(defective));
      assert.deepStrictEqual([...headers], []);

      const noop = yield* noopAIGatewayTelemetry.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      yield* noop.end({ streamOutcome: "not_streamed" });
    }).pipe(Effect.provide(BunCryptoLayer)));

  it.effect("continues Codex context with a fresh attempt and rejects malformed tracestate", () =>
    runWithNativeTelemetry((telemetry, spans) =>
      Effect.gen(function*() {
        const request = yield* telemetry.start(
          new Request("http://ai-gateway.test/v1/responses", {
            method: "POST",
            headers: {
              "user-agent": "codex-cli/0.144.5",
              traceparent:
                "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
              tracestate: "vendor=valid,malformed==value",
              "x-client-request-id": "long-lived-codex-thread",
            },
          }),
        );
        const upstream = new Headers();
        yield* request.upstreamStarted(upstream);
        yield* request.end({ status: 200, streamOutcome: "completed" });

        assert.strictEqual(
          spans[0]?.attributes.get("agentos.ai.runtime"),
          "codex",
        );
        assert.strictEqual(
          spans[0]?.traceId,
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert.strictEqual(upstream.get("x-client-request-id"), "gateway-2");
        assert.strictEqual(upstream.has("tracestate"), false);
      })
    ));
});
