import { describe, expect, test } from "bun:test";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createGatewayTelemetry,
  createNoopGatewayTelemetry,
} from "../src/telemetry.ts";
import {
  createAgentOSMetricViews,
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_AI_METRICS,
} from "@akua-dev/agentos";

function fixture() {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({
    readers: [metricReader],
    views: createAgentOSMetricViews(),
  });
  const logs: unknown[] = [];
  let nextId = 0;
  const telemetry = createGatewayTelemetry({
    tracer: tracerProvider.getTracer("gateway-test"),
    meter: meterProvider.getMeter("gateway-test"),
    propagator: new W3CTraceContextPropagator(),
    id: () => `gateway-${++nextId}`,
    clock: (() => {
      let now = 0;
      return () => (now += 10);
    })(),
    log: (record) => logs.push(record),
  });
  return { logs, meterProvider, metrics, spans, telemetry, tracerProvider };
}

describe("AI Gateway telemetry", () => {
  test("records bounded fresh and resumed session states", async () => {
    const test = fixture();
    for (const sessionState of ["fresh", "resumed", "private"]) {
      const scope = test.telemetry.startRequest(
        new Request("http://gateway.test/responses", {
          headers: { "x-agentos-session-state": sessionState },
        }),
      );
      scope.end({ status: 200, streamOutcome: "not_streamed" });
    }

    await test.tracerProvider.forceFlush();
    expect(
      test.spans
        .getFinishedSpans()
        .filter((span) => span.name === "ai-gateway.request")
        .map((span) => span.attributes["agentos.ai.session.state"]),
    ).toEqual(["fresh", "resumed", "fresh"]);

    await Promise.all([
      test.tracerProvider.shutdown(),
      test.meterProvider.shutdown(),
    ]);
  });

  test("traces routing, one provider attempt, streaming, and release with safe correlation", async () => {
    const test = fixture();
    const request = new Request("http://gateway.test/responses", {
      method: "POST",
      headers: {
        "x-agentos-runtime": "pi",
        "x-agentos-request-kind": "compaction",
        "x-agentos-model-family": "gpt-5",
        "x-agentos-stream-mode": "streaming",
      },
    });
    const scope = test.telemetry.startRequest(request);
    scope.authenticate(true);
    scope.routeStarted();
    scope.routeEnded("acquired");
    scope.quotaObservation(1.25, true);
    const headers = new Headers();
    scope.upstreamStarted(headers);
    expect(headers.get("x-client-request-id")).toBe("gateway-2");
    expect(headers.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    scope.upstreamHeaders(
      200,
      new Headers({ "x-request-id": "req_safe_provider_1" }),
    );
    scope.streamChunk(11);
    scope.streamChunk(13);
    scope.routeReleaseStarted();
    scope.routeReleased();
    scope.end({ status: 200, streamOutcome: "completed" });

    await Promise.all([
      test.tracerProvider.forceFlush(),
      test.meterProvider.forceFlush(),
    ]);
    const finished = test.spans.getFinishedSpans();
    expect(finished.map((span) => span.name)).toEqual([
      "ai-gateway.authenticate",
      "ai-gateway.route.acquire",
      "ai-gateway.route.release",
      "ai-gateway.stream",
      "ai-gateway.upstream",
      "ai-gateway.request",
    ]);
    expect(
      finished.find((span) => span.name === "ai-gateway.upstream")?.attributes,
    ).toMatchObject({
      "agentos.ai.request.attempt_id": "gateway-2",
      "agentos.ai.provider.request_id": "req_safe_provider_1",
      "agentos.ai.request.kind": "compaction",
      "agentos.ai.status_class": "success",
    });
    expect(
      finished.find((span) => span.name === "ai-gateway.stream")?.attributes,
    ).toMatchObject({
      "agentos.ai.stream.outcome": "completed",
      "agentos.ai.stream.chunks": 2,
      "agentos.ai.stream.bytes": 24,
    });
    const metricPayload = JSON.stringify(test.metrics.getMetrics());
    for (const name of [
      "agentos.ai.operations",
      "agentos.ai.provider.attempts",
      "agentos.ai.route.acquire.duration",
      "agentos.ai.upstream.headers.duration",
      "agentos.ai.stream.first_byte.duration",
      "agentos.ai.stream.duration",
      "agentos.ai.quota.observation.age",
      "agentos.ai.streams.active",
      "agentos.ai.stream.chunks",
      "agentos.ai.stream.bytes",
    ]) {
      expect(metricPayload).toContain(name);
    }
    expect(metricPayload).not.toContain("gateway-2");
    expect(metricPayload).not.toContain("req_safe_provider_1");
    const exportedMetrics = test.metrics
      .getMetrics()
      .flatMap(({ scopeMetrics }) =>
        scopeMetrics.flatMap(({ metrics: scopedMetrics }) => scopedMetrics),
      );
    const durationMetrics = exportedMetrics.filter(({ descriptor }) =>
      [
        AGENTOS_AI_METRICS.operationDuration,
        AGENTOS_AI_METRICS.providerDuration,
        AGENTOS_AI_METRICS.upstreamHeadersDuration,
        AGENTOS_AI_METRICS.firstByteDuration,
        AGENTOS_AI_METRICS.streamDuration,
        AGENTOS_AI_METRICS.routeAcquisitionDuration,
        AGENTOS_AI_METRICS.quotaObservationAge,
      ].includes(
        descriptor.name as typeof AGENTOS_AI_METRICS.operationDuration,
      ),
    );
    expect(durationMetrics).toHaveLength(7);
    for (const metric of durationMetrics) {
      expect(JSON.stringify(metric)).toContain(
        `"boundaries":${JSON.stringify([...AGENTOS_AI_DURATION_BUCKETS_SECONDS])}`,
      );
    }
    const quotaMetric = exportedMetrics.find(
      ({ descriptor }) =>
        descriptor.name === AGENTOS_AI_METRICS.quotaObservationAge,
    );
    expect(quotaMetric && JSON.stringify(quotaMetric)).toContain(
      '"agentos.ai.quota.stale":true',
    );

    await Promise.all([
      test.tracerProvider.shutdown(),
      test.meterProvider.shutdown(),
    ]);
  });

  test("records failures without payloads, credentials, provider identities, or error text", async () => {
    const test = fixture();
    const secret = "SEED_PROMPT sk-seeded-secret provider-account@example.test";
    const scope = test.telemetry.startRequest(
      new Request("http://gateway.test/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          baggage: `private=${secret}`,
          "x-agentos-runtime": "not-a-runtime",
          "x-agentos-request-kind": secret,
        },
      }),
    );
    scope.authenticate(true);
    scope.routeStarted();
    scope.routeEnded("acquired");
    scope.upstreamStarted(new Headers());
    scope.upstreamFailed(new TypeError(secret));
    scope.routeReleaseStarted();
    scope.routeReleased(new Error(secret));
    scope.end({
      status: 503,
      error: new TypeError(secret),
      streamOutcome: "upstream_error",
    });

    await Promise.all([
      test.tracerProvider.forceFlush(),
      test.meterProvider.forceFlush(),
    ]);
    const serialized = JSON.stringify({
      logs: test.logs,
      metrics: test.metrics.getMetrics(),
      spans: test.spans.getFinishedSpans().map((span) => ({
        attributes: span.attributes,
        events: span.events,
        name: span.name,
        status: span.status,
      })),
    });
    expect(serialized).not.toContain("SEED_PROMPT");
    expect(serialized).not.toContain("sk-seeded-secret");
    expect(serialized).not.toContain("provider-account@example.test");
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]).toMatchObject({
      event: "ai_gateway_failure",
      "agentos.ai.error.class": "overload",
      "agentos.ai.status_class": "server_error",
    });

    await Promise.all([
      test.tracerProvider.shutdown(),
      test.meterProvider.shutdown(),
    ]);
  });

  test("no-op telemetry is inert and never mutates upstream headers", () => {
    const scope = createNoopGatewayTelemetry().startRequest(
      new Request("http://gateway.test/responses"),
    );
    const headers = new Headers();
    expect(() => {
      scope.authenticate(false);
      scope.routeStarted();
      scope.routeEnded("unavailable");
      scope.quotaObservation(Number.POSITIVE_INFINITY, false);
      scope.upstreamStarted(headers);
      scope.upstreamFailed(new Error("private"));
      scope.routeReleaseStarted();
      scope.routeReleased();
      scope.streamChunk(4);
      scope.end({ status: 503, streamOutcome: "not_streamed" });
    }).not.toThrow();
    expect([...headers]).toEqual([]);
  });
});
