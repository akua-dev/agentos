import { describe, expect, it } from "@effect/vitest";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect } from "effect";

import { createGatewayTelemetry } from "../../../../../services/ai-gateway/src/telemetry.ts";
import { createAgentOSTelemetry } from "../runtime.ts";

const traceFixture = Effect.fn("test.telemetry.traceFixture")(function*() {
  const base = yield* Effect.sync(() => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spans)],
    });
    const tracer = provider.getTracer("agentos-propagation-test");
    const propagator = new W3CTraceContextPropagator();
    return { propagator, provider, spans, tracer };
  });
  let nextId = 0;
  const agent = yield* createAgentOSTelemetry({
    tracer: base.tracer,
    propagator: base.propagator,
    id: Effect.sync(() => `agent-${++nextId}`),
  });
  const gateway = yield* Effect.sync(() => createGatewayTelemetry({
    tracer: base.tracer,
    propagator: base.propagator,
    id: () => `gateway-${++nextId}`,
    log: () => undefined,
  }));
  return { ...base, agent, gateway };
});

const providerAction = (evaluate: () => Promise<unknown>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.asVoid);

describe("AgentOS AI trace propagation", () => {
  it.effect("connects a Pi operation through Gateway routing and streaming", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture();
      const operation = yield* fixture.agent.startOperation({
        runtime: "pi",
        route: "ai_gateway",
        sessionState: "resumed",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      });
      const attempt = yield* operation.startProviderAttempt({ requestKind: "main", streamMode: "streaming" });
      const headers = new Headers();
      yield* attempt.inject(headers);
      yield* Effect.sync(() => {
        headers.set("authorization", "Bearer SEED_SECRET");
        const gateway = fixture.gateway.startRequest(new Request("http://gateway.test/responses", {
          method: "POST",
          headers,
          body: "SEED_PROMPT",
        }));
        gateway.authenticate(true);
        gateway.routeStarted();
        gateway.routeEnded("acquired");
        gateway.upstreamStarted(new Headers());
        gateway.upstreamHeaders(200, new Headers({ "x-request-id": "req_safe_1" }));
        gateway.streamChunk(17);
        gateway.routeReleaseStarted();
        gateway.routeReleased();
        gateway.end({ status: 200, streamOutcome: "completed" });
      });
      yield* attempt.end({ status: 200, streamOutcome: "completed" });
      yield* operation.end({ status: 200 });
      yield* providerAction(() => fixture.provider.forceFlush());
      const spans = fixture.spans.getFinishedSpans();
      const named = new Map(spans.map((span) => [span.name, span]));
      const operationSpan = named.get("agentos.ai.operation");
      const attemptSpan = named.get("agentos.ai.provider.attempt");
      const requestSpan = named.get("ai-gateway.request");
      const upstreamSpan = named.get("ai-gateway.upstream");
      const streamSpan = named.get("ai-gateway.stream");
      expect(attemptSpan?.parentSpanContext?.spanId).toBe(operationSpan?.spanContext().spanId);
      expect(requestSpan?.parentSpanContext?.spanId).toBe(attemptSpan?.spanContext().spanId);
      expect(upstreamSpan?.parentSpanContext?.spanId).toBe(requestSpan?.spanContext().spanId);
      expect(streamSpan?.parentSpanContext?.spanId).toBe(upstreamSpan?.spanContext().spanId);
      expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
      const serialized = JSON.stringify(spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        name: span.name,
      })));
      expect(serialized).not.toContain("SEED_PROMPT");
      expect(serialized).not.toContain("SEED_SECRET");
      yield* providerAction(() => fixture.provider.shutdown());
    })
  );

  it.effect("a direct Pi route has no manufactured Gateway span", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture();
      const operation = yield* fixture.agent.startOperation({
        runtime: "pi",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "other",
        providerFamily: "openai",
      });
      const attempt = yield* operation.startProviderAttempt({ requestKind: "extension", streamMode: "non_streaming" });
      yield* attempt.end({ status: 200, streamOutcome: "not_streamed" });
      yield* operation.end({ status: 200 });
      yield* providerAction(() => fixture.provider.forceFlush());
      expect(fixture.spans.getFinishedSpans().map((span) => span.name).filter((name) => name.startsWith("ai-gateway."))).toEqual([]);
      yield* providerAction(() => fixture.provider.shutdown());
    })
  );

  it.effect("drops oversized malformed context instead of accepting arbitrary baggage", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture();
      yield* Effect.sync(() => {
        const gateway = fixture.gateway.startRequest(new Request("http://gateway.test/responses", {
          headers: {
            baggage: "private=SEED_SECRET",
            traceparent: `00-${"f".repeat(10_000)}-invalid-01`,
          },
        }));
        gateway.authenticate(false);
        gateway.end({ status: 401, streamOutcome: "not_streamed" });
      });
      yield* providerAction(() => fixture.provider.forceFlush());
      const request = fixture.spans.getFinishedSpans().find((span) => span.name === "ai-gateway.request");
      expect(request?.parentSpanContext).toBeUndefined();
      expect(JSON.stringify(request?.attributes)).not.toContain("SEED_SECRET");
      yield* providerAction(() => fixture.provider.shutdown());
    })
  );
});
