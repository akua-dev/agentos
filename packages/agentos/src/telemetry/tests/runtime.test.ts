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
  createAgentOSTelemetry,
  createNoopAgentOSTelemetry,
} from "../runtime.ts";

function testTelemetry() {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const metrics = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  let nextId = 0;
  const telemetry = createAgentOSTelemetry({
    enabled: true,
    tracer: tracerProvider.getTracer("agentos-test"),
    meter: meterProvider.getMeter("agentos-test"),
    propagator: new W3CTraceContextPropagator(),
    id: () => `attempt-${++nextId}`,
  });
  return {
    meterProvider,
    metrics,
    spans,
    telemetry,
    tracerProvider,
  };
}

describe("AgentOS fail-open telemetry runtime", () => {
  test("connects an operation and its provider attempts with unique safe IDs", async () => {
    const fixture = testTelemetry();
    const operation = fixture.telemetry.startOperation({
      runtime: "pi",
      runtimeVersion: "0.81.1",
      route: "ai_gateway",
      sessionState: "resumed",
      modelFamily: "gpt-5",
      providerFamily: "openai",
    });
    const first = operation.startProviderAttempt({
      requestKind: "main",
      streamMode: "streaming",
    });
    const firstHeaders = new Headers();
    first.inject(firstHeaders);
    const second = operation.startProviderAttempt({
      requestKind: "compaction",
      streamMode: "non_streaming",
    });
    const secondHeaders = new Headers();
    second.inject(secondHeaders);

    expect(first.id).toBe("attempt-2");
    expect(second.id).toBe("attempt-3");
    expect(firstHeaders.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    expect(firstHeaders.get("x-agentos-request-attempt-id")).toBe(
      "attempt-2",
    );
    expect(secondHeaders.get("x-agentos-request-attempt-id")).toBe(
      "attempt-3",
    );
    expect(firstHeaders.get("traceparent")?.split("-")[1]).toBe(
      secondHeaders.get("traceparent")?.split("-")[1],
    );

    first.end({
      status: 200,
      streamOutcome: "completed",
      providerRequestId: "req_safe_1",
      chunks: 3,
      bytes: 120,
      inputTokens: 10,
      outputTokens: 20,
    });
    first.end({ status: 503, streamOutcome: "upstream_error" });
    second.end({ status: 503, streamOutcome: "not_streamed" });
    operation.end({ status: 503 });
    operation.end({ status: 200 });

    await Promise.all([
      fixture.tracerProvider.forceFlush(),
      fixture.meterProvider.forceFlush(),
    ]);
    const finished = fixture.spans.getFinishedSpans();
    expect(finished.map((span) => span.name)).toEqual([
      "agentos.ai.provider.attempt",
      "agentos.ai.provider.attempt",
      "agentos.ai.operation",
    ]);
    const [firstSpan, secondSpan, operationSpan] = finished;
    expect(firstSpan?.parentSpanContext?.spanId).toBe(
      operationSpan?.spanContext().spanId,
    );
    expect(secondSpan?.parentSpanContext?.spanId).toBe(
      operationSpan?.spanContext().spanId,
    );
    expect(firstSpan?.attributes).toMatchObject({
      "agentos.ai.request.attempt_id": "attempt-2",
      "agentos.ai.request.kind": "main",
      "agentos.ai.error.class": "none",
      "agentos.ai.status_class": "success",
      "agentos.ai.provider.request_id": "req_safe_1",
      "http.response.status_code": 200,
    });
    expect(secondSpan?.attributes).toMatchObject({
      "agentos.ai.request.attempt_id": "attempt-3",
      "agentos.ai.request.kind": "compaction",
      "agentos.ai.error.class": "overload",
      "agentos.ai.status_class": "server_error",
    });

    const metricPayload = JSON.stringify(fixture.metrics.getMetrics());
    expect(metricPayload).toContain("agentos.ai.provider.attempts");
    expect(metricPayload).toContain("agentos.ai.operations");
    expect(metricPayload).toContain("agentos.ai.provider.duration");
    expect(metricPayload).not.toContain("attempt-2");
    expect(metricPayload).not.toContain("attempt-3");
    expect(metricPayload).not.toContain("req_safe_1");
    expect(
      (metricPayload.match(/agentos.ai.provider.attempts/g) ?? []).length,
    ).toBe(1);

    await Promise.all([
      fixture.tracerProvider.shutdown(),
      fixture.meterProvider.shutdown(),
    ]);
  });

  test("drops malformed parent context and forbidden values", async () => {
    const fixture = testTelemetry();
    const operation = fixture.telemetry.startOperation(
      {
        runtime: "pi",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      },
      {
        traceparent: `00-${"x".repeat(10_000)}-not-valid-01`,
        baggage: "provider.account.id=provider-private",
      },
    );
    const attempt = operation.startProviderAttempt({
      requestKind: "main",
      streamMode: "streaming",
    });
    attempt.end({
      status: 500,
      error: new Error(
        "SEED_PROMPT sk-seeded-secret provider-account@example.test",
      ),
      streamOutcome: "upstream_error",
    });
    operation.end({
      status: 500,
      error: new Error("SEED_PROMPT"),
    });

    await fixture.tracerProvider.forceFlush();
    const serialized = JSON.stringify(
      fixture.spans
        .getFinishedSpans()
        .map(({ attributes, events, name, status }) => ({
          attributes,
          events,
          name,
          status,
        })),
    );
    expect(serialized).not.toContain("SEED_PROMPT");
    expect(serialized).not.toContain("sk-seeded-secret");
    expect(serialized).not.toContain("provider-account@example.test");
    expect(serialized).not.toContain("provider.account.id");
    await Promise.all([
      fixture.tracerProvider.shutdown(),
      fixture.meterProvider.shutdown(),
    ]);
  });

  test("returns inert no-throw scopes when disabled", () => {
    const telemetry = createNoopAgentOSTelemetry();
    const operation = telemetry.startOperation({
      runtime: "pi",
      route: "direct",
      sessionState: "fresh",
      modelFamily: "other",
      providerFamily: "other",
    });
    const attempt = operation.startProviderAttempt({
      requestKind: "extension",
      streamMode: "non_streaming",
    });
    const headers = new Headers();
    expect(() => {
      attempt.inject(headers);
      attempt.end({ status: 503, error: new Error("private") });
      operation.end({ status: 503 });
    }).not.toThrow();
    expect([...headers.entries()]).toEqual([]);
  });
});
