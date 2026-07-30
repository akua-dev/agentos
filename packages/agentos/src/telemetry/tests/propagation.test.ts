import { describe, expect, test } from "bun:test";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createGatewayTelemetry } from "../../../../../services/ai-gateway/src/telemetry.ts";
import { createAgentOSTelemetry } from "../runtime.ts";

function traceFixture() {
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const tracer = provider.getTracer("agentos-propagation-test");
  const propagator = new W3CTraceContextPropagator();
  let nextId = 0;
  return {
    agent: createAgentOSTelemetry({
      tracer,
      propagator,
      id: () => `agent-${++nextId}`,
    }),
    gateway: createGatewayTelemetry({
      tracer,
      propagator,
      id: () => `gateway-${++nextId}`,
      log: () => undefined,
    }),
    provider,
    spans,
  };
}

describe("AgentOS AI trace propagation", () => {
  test("connects a Pi operation through Gateway routing and streaming", async () => {
    const fixture = traceFixture();
    const operation = fixture.agent.startOperation({
      runtime: "pi",
      route: "ai_gateway",
      sessionState: "resumed",
      modelFamily: "gpt-5",
      providerFamily: "openai",
    });
    const attempt = operation.startProviderAttempt({
      requestKind: "main",
      streamMode: "streaming",
    });
    const headers = new Headers();
    attempt.inject(headers);
    headers.set("authorization", "Bearer SEED_SECRET");
    const gateway = fixture.gateway.startRequest(
      new Request("http://gateway.test/responses", {
        method: "POST",
        headers,
        body: "SEED_PROMPT",
      }),
    );
    gateway.authenticate(true);
    gateway.routeStarted();
    gateway.routeEnded("acquired");
    gateway.upstreamStarted(new Headers());
    gateway.upstreamHeaders(
      200,
      new Headers({ "x-request-id": "req_safe_1" }),
    );
    gateway.streamChunk(17);
    gateway.routeReleaseStarted();
    gateway.routeReleased();
    gateway.end({ status: 200, streamOutcome: "completed" });
    attempt.end({ status: 200, streamOutcome: "completed" });
    operation.end({ status: 200 });

    await fixture.provider.forceFlush();
    const spans = fixture.spans.getFinishedSpans();
    const named = new Map(spans.map((span) => [span.name, span]));
    const operationSpan = named.get("agentos.ai.operation");
    const attemptSpan = named.get("agentos.ai.provider.attempt");
    const requestSpan = named.get("ai-gateway.request");
    const upstreamSpan = named.get("ai-gateway.upstream");
    const streamSpan = named.get("ai-gateway.stream");
    expect(attemptSpan?.parentSpanContext?.spanId).toBe(
      operationSpan?.spanContext().spanId,
    );
    expect(requestSpan?.parentSpanContext?.spanId).toBe(
      attemptSpan?.spanContext().spanId,
    );
    expect(upstreamSpan?.parentSpanContext?.spanId).toBe(
      requestSpan?.spanContext().spanId,
    );
    expect(streamSpan?.parentSpanContext?.spanId).toBe(
      upstreamSpan?.spanContext().spanId,
    );
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(
      1,
    );

    const serialized = JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        name: span.name,
      })),
    );
    expect(serialized).not.toContain("SEED_PROMPT");
    expect(serialized).not.toContain("SEED_SECRET");
    await fixture.provider.shutdown();
  });

  test("a direct Pi route has no manufactured Gateway span", async () => {
    const fixture = traceFixture();
    const operation = fixture.agent.startOperation({
      runtime: "pi",
      route: "direct",
      sessionState: "fresh",
      modelFamily: "other",
      providerFamily: "openai",
    });
    const attempt = operation.startProviderAttempt({
      requestKind: "extension",
      streamMode: "non_streaming",
    });
    attempt.end({ status: 200, streamOutcome: "not_streamed" });
    operation.end({ status: 200 });
    await fixture.provider.forceFlush();

    expect(
      fixture.spans
        .getFinishedSpans()
        .map((span) => span.name)
        .filter((name) => name.startsWith("ai-gateway.")),
    ).toEqual([]);
    await fixture.provider.shutdown();
  });

  test("drops oversized malformed context instead of accepting arbitrary baggage", async () => {
    const fixture = traceFixture();
    const gateway = fixture.gateway.startRequest(
      new Request("http://gateway.test/responses", {
        headers: {
          baggage: "private=SEED_SECRET",
          traceparent: `00-${"f".repeat(10_000)}-invalid-01`,
        },
      }),
    );
    gateway.authenticate(false);
    gateway.end({ status: 401, streamOutcome: "not_streamed" });
    await fixture.provider.forceFlush();
    const request = fixture.spans
      .getFinishedSpans()
      .find((span) => span.name === "ai-gateway.request");
    expect(request?.parentSpanContext).toBeUndefined();
    expect(JSON.stringify(request?.attributes)).not.toContain("SEED_SECRET");
    await fixture.provider.shutdown();
  });
});
