import { describe, expect, it } from "@effect/vitest";
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
import { Effect } from "effect";

import {
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_AI_METRICS,
} from "../contract.ts";
import {
  createAgentOSMetricViews,
  createAgentOSTelemetry,
  createNoopAgentOSTelemetry,
} from "../runtime.ts";

const testTelemetry = Effect.fn("test.telemetry.fixture")(function*() {
  const fixture = yield* Effect.sync(() => {
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
    return { meterProvider, metrics, spans, tracerProvider };
  });
  let nextId = 0;
  const telemetry = yield* createAgentOSTelemetry({
    enabled: true,
    tracer: fixture.tracerProvider.getTracer("agentos-test"),
    meter: fixture.meterProvider.getMeter("agentos-test"),
    propagator: new W3CTraceContextPropagator(),
    id: Effect.sync(() => `attempt-${++nextId}`),
  });
  return { ...fixture, telemetry };
});

const foreignPromise = (evaluate: () => Promise<unknown>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.asVoid);

describe("AgentOS fail-open telemetry runtime", () => {
  it.effect("connects an operation and its provider attempts with unique safe IDs", () =>
    Effect.gen(function*() {
      const fixture = yield* testTelemetry();
      const operation = yield* fixture.telemetry.startOperation({
        runtime: "pi",
        runtimeVersion: "0.81.1",
        route: "ai_gateway",
        sessionState: "resumed",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      });
      const first = yield* operation.startProviderAttempt({ requestKind: "main", streamMode: "streaming" });
      const firstHeaders = new Headers();
      yield* first.inject(firstHeaders);
      const second = yield* operation.startProviderAttempt({
        requestKind: "compaction",
        streamMode: "non_streaming",
        compactionPath: "portable_summary",
      });
      const secondHeaders = new Headers();
      yield* second.inject(secondHeaders);

      expect(first.id).toBe("attempt-2");
      expect(second.id).toBe("attempt-3");
      expect(firstHeaders.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(firstHeaders.get("x-agentos-request-attempt-id")).toBe("attempt-2");
      expect(firstHeaders.get("x-agentos-runtime")).toBe("pi");
      expect(firstHeaders.get("x-agentos-request-kind")).toBe("main");
      expect(firstHeaders.get("x-agentos-model-family")).toBe("gpt-5");
      expect(firstHeaders.get("x-agentos-stream-mode")).toBe("streaming");
      expect(firstHeaders.get("x-agentos-session-state")).toBe("resumed");
      expect(secondHeaders.get("x-agentos-request-attempt-id")).toBe("attempt-3");
      expect(firstHeaders.get("traceparent")?.split("-")[1]).toBe(secondHeaders.get("traceparent")?.split("-")[1]);

      yield* first.end({
        status: 200,
        streamOutcome: "completed",
        providerRequestId: "req_safe_1",
        chunks: 3,
        bytes: 120,
        inputTokens: 10,
        outputTokens: 20,
      });
      yield* first.end({ status: 503, streamOutcome: "upstream_error" });
      yield* second.end({ status: 503, streamOutcome: "not_streamed" });
      yield* operation.end({ status: 503 });
      yield* operation.end({ status: 200 });
      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.forceFlush()),
        foreignPromise(() => fixture.meterProvider.forceFlush()),
      ], { concurrency: "unbounded", discard: true });

      const finished = fixture.spans.getFinishedSpans();
      expect(finished.map((span) => span.name)).toEqual([
        "agentos.ai.provider.attempt",
        "agentos.ai.provider.attempt",
        "agentos.ai.operation",
      ]);
      const [firstSpan, secondSpan, operationSpan] = finished;
      expect(firstSpan?.parentSpanContext?.spanId).toBe(operationSpan?.spanContext().spanId);
      expect(secondSpan?.parentSpanContext?.spanId).toBe(operationSpan?.spanContext().spanId);
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
        "agentos.ai.compaction.path": "portable_summary",
        "agentos.ai.error.class": "overload",
        "agentos.ai.status_class": "server_error",
      });

      const metricPayload = JSON.stringify(fixture.metrics.getMetrics());
      expect(metricPayload).toContain("agentos.ai.provider.attempts");
      expect(metricPayload).toContain("agentos.ai.operations");
      expect(metricPayload).toContain("agentos.ai.provider.duration");
      expect(metricPayload).toContain("portable_summary");
      expect(metricPayload).not.toContain("attempt-2");
      expect(metricPayload).not.toContain("attempt-3");
      expect(metricPayload).not.toContain("req_safe_1");
      expect((metricPayload.match(/agentos.ai.provider.attempts/g) ?? []).length).toBe(1);
      const durationNames = new Set<string>([
        AGENTOS_AI_METRICS.operationDuration,
        AGENTOS_AI_METRICS.providerDuration,
      ]);
      const durationMetrics = fixture.metrics.getMetrics()
        .flatMap(({ scopeMetrics }) => scopeMetrics.flatMap(({ metrics }) => metrics))
        .filter(({ descriptor }) => durationNames.has(descriptor.name));
      expect(durationMetrics).toHaveLength(2);
      for (const metric of durationMetrics) {
        expect(JSON.stringify(metric)).toContain(
          `"boundaries":${JSON.stringify([...AGENTOS_AI_DURATION_BUCKETS_SECONDS])}`,
        );
      }
      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.shutdown()),
        foreignPromise(() => fixture.meterProvider.shutdown()),
      ], { concurrency: "unbounded", discard: true });
    })
  );

  it.effect("emits private correlation headers only for explicit AI Gateway routes", () =>
    Effect.gen(function*() {
      const fixture = yield* testTelemetry();
      const operation = yield* fixture.telemetry.startOperation({
        runtime: "codex",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      });
      const attempt = yield* operation.startProviderAttempt({ requestKind: "main", streamMode: "streaming" });
      const headers = new Headers();
      yield* attempt.inject(headers);
      expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect([...headers.keys()].filter((name) => name.startsWith("x-agentos-"))).toEqual([]);
      yield* attempt.end({ status: 200, streamOutcome: "completed" });
      yield* operation.end({ status: 200 });
      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.shutdown()),
        foreignPromise(() => fixture.meterProvider.shutdown()),
      ], { concurrency: "unbounded", discard: true });
    })
  );

  it.effect("drops malformed parent context and forbidden values", () =>
    Effect.gen(function*() {
      const fixture = yield* testTelemetry();
      const operation = yield* fixture.telemetry.startOperation({
        runtime: "pi",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      }, {
        traceparent: `00-${"x".repeat(10_000)}-not-valid-01`,
        baggage: "provider.account.id=provider-private",
      });
      const attempt = yield* operation.startProviderAttempt({ requestKind: "main", streamMode: "streaming" });
      yield* attempt.end({
        status: 500,
        error: new Error("SEED_PROMPT sk-seeded-secret provider-account@example.test"),
        streamOutcome: "upstream_error",
      });
      yield* operation.end({ status: 500, error: new Error("SEED_PROMPT") });
      yield* foreignPromise(() => fixture.tracerProvider.forceFlush());
      const serialized = JSON.stringify(fixture.spans.getFinishedSpans().map(
        ({ attributes, events, name, status }) => ({ attributes, events, name, status }),
      ));
      expect(serialized).not.toContain("SEED_PROMPT");
      expect(serialized).not.toContain("sk-seeded-secret");
      expect(serialized).not.toContain("provider-account@example.test");
      expect(serialized).not.toContain("provider.account.id");
      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.shutdown()),
        foreignPromise(() => fixture.meterProvider.shutdown()),
      ], { concurrency: "unbounded", discard: true });
    })
  );

  it.effect("returns inert no-throw scopes when disabled", () =>
    Effect.gen(function*() {
      const telemetry = createNoopAgentOSTelemetry();
      const operation = yield* telemetry.startOperation({
        runtime: "pi",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "other",
        providerFamily: "other",
      });
      const attempt = yield* operation.startProviderAttempt({ requestKind: "extension", streamMode: "non_streaming" });
      const headers = new Headers();
      yield* attempt.inject(headers);
      yield* attempt.end({ status: 503, error: new Error("private") });
      yield* operation.end({ status: 503 });
      expect([...headers.entries()]).toEqual([]);
    })
  );
});
