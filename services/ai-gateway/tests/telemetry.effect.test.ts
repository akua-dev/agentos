import { assert, describe, it } from "@effect/vitest";
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
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";
import { Data, Effect } from "effect";

const authorization: ProviderAuthorizationGrantV1 = {
  schemaVersion: 1,
  correlationId: "corr_44444444444444444444444444444444",
  decisionRef: "decision_22222222222222222222222222222222",
  expiresAtMillis: 1_785_586_015_000,
  credentialDomain: "openai-responses",
  identity: {
    agentId: "10000000-0000-4000-8000-000000000001",
    role: "crewmate",
    fleet: "agentos",
    domain: "engineering",
    assignmentId: "20000000-0000-4000-8000-000000000001",
  },
  capability: "openai.responses.create",
  resource: {
    kind: "provider_service",
    provider: "openai",
    service: "responses",
  },
  profile: { profileId: "openai-responses", profileVersion: 7 },
  ceiling: {
    ceilingId: "ceiling_33333333333333333333333333333333",
    revision: 9,
  },
  rateClass: "standard",
};

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
  const logs: Array<Readonly<Record<string, string | number>>> = [];
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

type TelemetryFixture = ReturnType<typeof fixture>;

class TelemetryTestBoundaryError extends Data.TaggedError(
  "TelemetryTestBoundaryError",
)<{ readonly operation: "flush" | "shutdown" }> {}

function fixtureScoped() {
  return Effect.acquireRelease(
    Effect.sync(fixture),
    (test) =>
      Effect.all([
        Effect.tryPromise({
          try: () => test.tracerProvider.shutdown(),
          catch: () => new TelemetryTestBoundaryError({
            operation: "shutdown",
          }),
        }),
        Effect.tryPromise({
          try: () => test.meterProvider.shutdown(),
          catch: () => new TelemetryTestBoundaryError({
            operation: "shutdown",
          }),
        }),
      ], { concurrency: "unbounded", discard: true }).pipe(
        Effect.catchCause(() => Effect.void),
      ),
  );
}

function flush(test: TelemetryFixture, metrics: boolean) {
  return Effect.all([
    Effect.tryPromise({
      try: () => test.tracerProvider.forceFlush(),
      catch: () => new TelemetryTestBoundaryError({ operation: "flush" }),
    }),
    ...(metrics
      ? [Effect.tryPromise({
          try: () => test.meterProvider.forceFlush(),
          catch: () => new TelemetryTestBoundaryError({ operation: "flush" }),
        })]
      : []),
  ], { concurrency: "unbounded", discard: true });
}

describe("AI Gateway telemetry", () => {
  it.effect("records bounded fresh and resumed session states", () =>
    Effect.scoped(Effect.gen(function*() {
      const test = yield* fixtureScoped();
      for (const sessionState of ["fresh", "resumed", "private"]) {
        const scope = test.telemetry.startRequest(
          new Request("http://gateway.test/responses", {
            headers: { "x-agentos-session-state": sessionState },
          }),
        );
        scope.end({ status: 200, streamOutcome: "not_streamed" });
      }
      yield* flush(test, false);
      assert.deepStrictEqual(
        test.spans
          .getFinishedSpans()
          .filter((span) => span.name === "ai-gateway.request")
          .map((span) => span.attributes["agentos.ai.session.state"]),
        ["fresh", "resumed", "fresh"],
      );
    })));

  it.effect("traces routing, one provider attempt, streaming, and release with safe correlation", () =>
    Effect.scoped(Effect.gen(function*() {
      const test = yield* fixtureScoped();
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
      scope.authenticate(true, authorization);
      scope.routeStarted();
      scope.routeEnded("acquired");
      scope.quotaObservation(1.25, true);
      const headers = new Headers();
      scope.upstreamStarted(headers);
      assert.strictEqual(headers.get("x-client-request-id"), "gateway-2");
      assert.match(
        headers.get("traceparent") ?? "",
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
      yield* flush(test, true);

      const finished = test.spans.getFinishedSpans();
      assert.deepStrictEqual(finished.map((span) => span.name), [
        "ai-gateway.authenticate",
        "ai-gateway.route.acquire",
        "ai-gateway.route.release",
        "ai-gateway.stream",
        "ai-gateway.upstream",
        "ai-gateway.request",
      ]);
      const upstream = finished.find((span) =>
        span.name === "ai-gateway.upstream"
      );
      assert.strictEqual(
        upstream?.attributes["agentos.ai.request.attempt_id"],
        "gateway-2",
      );
      assert.strictEqual(
        upstream?.attributes["agentos.ai.provider.request_id"],
        "req_safe_provider_1",
      );
      assert.strictEqual(
        upstream?.attributes["agentos.ai.request.kind"],
        "compaction",
      );
      assert.strictEqual(
        upstream?.attributes["agentos.ai.status_class"],
        "success",
      );
      assert.strictEqual(
        upstream?.attributes["agentos.identity.agent_id"],
        authorization.identity.agentId,
      );
      assert.strictEqual(
        upstream?.attributes["agentos.identity.assignment_id"],
        authorization.identity.assignmentId,
      );
      assert.strictEqual(
        upstream?.attributes["agentos.authz.profile_id"],
        authorization.profile.profileId,
      );
      assert.strictEqual(
        upstream?.attributes["agentos.authz.profile_version"],
        authorization.profile.profileVersion,
      );
      assert.strictEqual(
        upstream?.attributes["agentos.authz.rate_class"],
        authorization.rateClass,
      );
      assert.strictEqual(
        upstream?.attributes["agentos.authz.decision_ref"],
        authorization.decisionRef,
      );
      const stream = finished.find((span) => span.name === "ai-gateway.stream");
      assert.strictEqual(
        stream?.attributes["agentos.ai.stream.outcome"],
        "completed",
      );
      assert.strictEqual(stream?.attributes["agentos.ai.stream.chunks"], 2);
      assert.strictEqual(stream?.attributes["agentos.ai.stream.bytes"], 24);

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
        assert.include(metricPayload, name);
      }
      assert.notInclude(metricPayload, "gateway-2");
      assert.notInclude(metricPayload, "req_safe_provider_1");
      assert.notInclude(metricPayload, authorization.identity.agentId);
      assert.notInclude(metricPayload, "agentos.ai.session.state");
      assert.notInclude(metricPayload, "agentos.ai.provider.family");
      assert.notInclude(metricPayload, "agentos.authz.profile_id");
      if (authorization.identity.assignmentId !== null) {
        assert.notInclude(metricPayload, authorization.identity.assignmentId);
      }
      const exportedMetrics = test.metrics
        .getMetrics()
        .flatMap(({ scopeMetrics }) =>
          scopeMetrics.flatMap(({ metrics: scopedMetrics }) => scopedMetrics)
        );
      const durationMetricNames: ReadonlyArray<string> = [
        AGENTOS_AI_METRICS.operationDuration,
        AGENTOS_AI_METRICS.providerDuration,
        AGENTOS_AI_METRICS.upstreamHeadersDuration,
        AGENTOS_AI_METRICS.firstByteDuration,
        AGENTOS_AI_METRICS.streamDuration,
        AGENTOS_AI_METRICS.routeAcquisitionDuration,
        AGENTOS_AI_METRICS.quotaObservationAge,
      ];
      const durationMetrics = exportedMetrics.filter(({ descriptor }) =>
        durationMetricNames.includes(descriptor.name)
      );
      assert.lengthOf(durationMetrics, 7);
      for (const metric of durationMetrics) {
        assert.include(
          JSON.stringify(metric),
          `"boundaries":${JSON.stringify([...AGENTOS_AI_DURATION_BUCKETS_SECONDS])}`,
        );
      }
      const quotaMetric = exportedMetrics.find(
        ({ descriptor }) =>
          descriptor.name === AGENTOS_AI_METRICS.quotaObservationAge,
      );
      assert.include(
        quotaMetric === undefined ? "" : JSON.stringify(quotaMetric),
        '"agentos.ai.quota.stale":true',
      );
    })));

  it.effect("records failures without payloads, credentials, provider identities, or error text", () =>
    Effect.scoped(Effect.gen(function*() {
      const test = yield* fixtureScoped();
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
      yield* flush(test, true);

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
      assert.notInclude(serialized, "SEED_PROMPT");
      assert.notInclude(serialized, "sk-seeded-secret");
      assert.notInclude(serialized, "provider-account@example.test");
      assert.lengthOf(test.logs, 1);
      const record = test.logs[0];
      assert.strictEqual(record?.event, "ai_gateway_failure");
      assert.strictEqual(record?.["agentos.ai.error.class"], "overload");
      assert.strictEqual(
        record?.["agentos.ai.status_class"],
        "server_error",
      );
    })));

  it.effect("keeps no-op telemetry inert without mutating upstream headers", () =>
    Effect.sync(() => {
      const scope = createNoopGatewayTelemetry().startRequest(
        new Request("http://gateway.test/responses"),
      );
      const headers = new Headers();
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
      assert.deepStrictEqual([...headers], []);
    }));

  it.effect("records authorization denial as 403 instead of authentication failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const test = yield* fixtureScoped();
      const scope = test.telemetry.startRequest(
        new Request("http://gateway.test/responses"),
      );
      scope.authenticate(false, undefined, 403);
      scope.end({ status: 403, streamOutcome: "not_streamed" });
      yield* flush(test, false);
      const attributes = test.spans
        .getFinishedSpans()
        .find((span) => span.name === "ai-gateway.authenticate")
        ?.attributes;
      assert.strictEqual(
        attributes?.["agentos.ai.status_class"],
        "client_error",
      );
      assert.strictEqual(attributes?.["http.response.status_code"], 403);
    })));
});
