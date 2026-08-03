import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { describe, expect, it } from "@effect/vitest";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Option, Ref, Tracer } from "effect";

import { makeAIGatewayTelemetry } from "../../../../../services/ai-gateway/src/observability.ts";
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
  const nextId = yield* Ref.make(0);
  const id = Ref.getAndUpdate(nextId, (value) => value + 1).pipe(
    Effect.map((value) => `trace-${value + 1}`),
  );
  const agent = yield* createAgentOSTelemetry({
    tracer: base.tracer,
    propagator: base.propagator,
    id,
  });
  const gatewaySpans: Array<Tracer.NativeSpan> = [];
  const gatewayTracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      gatewaySpans.push(span);
      return span;
    },
  });
  const gateway = yield* makeAIGatewayTelemetry({ nextId: id });
  return { ...base, agent, gateway, gatewaySpans, gatewayTracer };
});

const providerAction = (evaluate: () => Promise<unknown>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(
    Effect.asVoid,
  );

describe("AgentOS AI trace propagation", () => {
  it.effect("connects a Pi operation through native Effect Gateway spans", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture().pipe(Effect.provide(BunCryptoLayer));
      const operation = yield* fixture.agent.startOperation({
        runtime: "pi",
        route: "ai_gateway",
        sessionState: "resumed",
        modelFamily: "gpt-5",
        providerFamily: "openai",
      });
      const attempt = yield* operation.startProviderAttempt({
        requestKind: "main",
        streamMode: "streaming",
      });
      const headers = new Headers();
      yield* attempt.inject(headers);
      yield* Effect.sync(() => {
        headers.set("authorization", "Bearer SEED_SECRET");
      });
      yield* Effect.gen(function*() {
        const gateway = yield* fixture.gateway.start(new Request(
          "http://gateway.test/responses",
          { method: "POST", headers, body: "SEED_PROMPT" },
        ));
        yield* gateway.authenticate(true);
        yield* gateway.routeStarted;
        yield* gateway.routeEnded("acquired");
        yield* gateway.upstreamStarted(new Headers());
        yield* gateway.upstreamHeaders(
          200,
          new Headers({ "x-request-id": "req_safe_1" }),
        );
        yield* gateway.streamChunk(17);
        yield* gateway.routeReleaseStarted;
        yield* gateway.routeReleased;
        yield* gateway.end({ status: 200, streamOutcome: "completed" });
      }).pipe(Effect.withTracer(fixture.gatewayTracer));
      yield* attempt.end({ status: 200, streamOutcome: "completed" });
      yield* operation.end({ status: 200 });
      yield* providerAction(() => fixture.provider.forceFlush());

      const agentSpans = fixture.spans.getFinishedSpans();
      const operationSpan = agentSpans.find(({ name }) =>
        name === "agentos.ai.operation"
      );
      const attemptSpan = agentSpans.find(({ name }) =>
        name === "agentos.ai.provider.attempt"
      );
      const requestSpan = fixture.gatewaySpans.find(({ name }) =>
        name === "ai-gateway.request"
      );
      const upstreamSpan = fixture.gatewaySpans.find(({ name }) =>
        name === "ai-gateway.upstream"
      );
      const streamSpan = fixture.gatewaySpans.find(({ name }) =>
        name === "ai-gateway.stream"
      );
      expect(attemptSpan?.parentSpanContext?.spanId).toBe(
        operationSpan?.spanContext().spanId,
      );
      expect(Option.getOrUndefined(requestSpan?.parent ?? Option.none())?.spanId)
        .toBe(attemptSpan?.spanContext().spanId);
      expect(Option.getOrUndefined(upstreamSpan?.parent ?? Option.none())?.spanId)
        .toBe(requestSpan?.spanId);
      expect(Option.getOrUndefined(streamSpan?.parent ?? Option.none())?.spanId)
        .toBe(upstreamSpan?.spanId);
      expect(new Set([
        ...agentSpans.map((span) => span.spanContext().traceId),
        ...fixture.gatewaySpans.map(({ traceId }) => traceId),
      ]).size).toBe(1);
      const serialized = JSON.stringify([
        ...agentSpans.map((span) => ({
          attributes: span.attributes,
          events: span.events,
          name: span.name,
        })),
        ...fixture.gatewaySpans.map((span) => ({
          attributes: Object.fromEntries(span.attributes),
          events: span.events,
          name: span.name,
        })),
      ]);
      expect(serialized).not.toContain("SEED_PROMPT");
      expect(serialized).not.toContain("SEED_SECRET");
      yield* providerAction(() => fixture.provider.shutdown());
    }));

  it.effect("a direct Pi route has no manufactured Gateway span", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture().pipe(Effect.provide(BunCryptoLayer));
      const operation = yield* fixture.agent.startOperation({
        runtime: "pi",
        route: "direct",
        sessionState: "fresh",
        modelFamily: "other",
        providerFamily: "openai",
      });
      const attempt = yield* operation.startProviderAttempt({
        requestKind: "extension",
        streamMode: "non_streaming",
      });
      yield* attempt.end({ status: 200, streamOutcome: "not_streamed" });
      yield* operation.end({ status: 200 });
      expect(fixture.gatewaySpans).toEqual([]);
      yield* providerAction(() => fixture.provider.shutdown());
    }));

  it.effect("drops oversized malformed context and arbitrary baggage", () =>
    Effect.gen(function*() {
      const fixture = yield* traceFixture().pipe(Effect.provide(BunCryptoLayer));
      yield* Effect.gen(function*() {
        const gateway = yield* fixture.gateway.start(new Request(
          "http://gateway.test/responses",
          {
            headers: {
              baggage: "private=SEED_SECRET",
              traceparent: `00-${"f".repeat(10_000)}-invalid-01`,
            },
          },
        ));
        yield* gateway.authenticate(false);
        yield* gateway.end({ status: 401, streamOutcome: "not_streamed" });
      }).pipe(Effect.withTracer(fixture.gatewayTracer));
      const request = fixture.gatewaySpans.find(({ name }) =>
        name === "ai-gateway.request"
      );
      expect(Option.isNone(request?.parent ?? Option.none())).toBe(true);
      expect(JSON.stringify(Object.fromEntries(request?.attributes ?? [])))
        .not.toContain("SEED_SECRET");
      yield* providerAction(() => fixture.provider.shutdown());
    }));
});
