import { describe, expect, it } from "@effect/vitest";
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

import type { ResilienceObservationV1 } from "../resilience-contract.ts";
import {
  createAgentOSResilienceMetricViews,
  createAgentOSResilienceTelemetry,
  createNoopAgentOSResilienceTelemetry,
} from "../resilience-runtime.ts";

const AgentId = "11111111-1111-4111-8111-111111111111";
const AssignmentId = "22222222-2222-4222-8222-222222222222";
const OperationId = "33333333-3333-4333-8333-333333333333";

const event = (phase: ResilienceObservationV1["phase"]): ResilienceObservationV1 => ({
  version: 1,
  source: phase === "protocol" ? "a2a" : "runtime_journal",
  phase,
  evidence: "observed",
  outcome: phase === "outcome" ? "recovered" : "degraded",
  cause: phase === "protocol" ? "protocol_adapter" : "reconciliation",
  failureClass: null,
  recovery: phase === "protocol" ? "postgresql_listener_then_herdr_wake" : "repair_forward",
  attempt: 1,
  topologyAction: null,
  topologyReason: null,
  runtimeAction: "recover",
  workloadProfile: null,
  workloadSpecVersion: null,
  workloadSpecDigest: null,
  workloadOverlayDigest: null,
  renderedManifestDigest: null,
  journalPhase: phase === "protocol" ? null : "recovery_required",
  protocol: phase === "protocol" ? "a2a" : null,
  protected: {
    agentId: AgentId,
    assignmentId: AssignmentId,
    operationId: OperationId,
    proposalId: null,
    podUid: null,
    pvcUid: null,
    sessionId: "pi-session-01",
    protocolId: phase === "protocol" ? "a2a-task-01" : null,
  },
});

const foreignPromise = (evaluate: () => Promise<unknown>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.asVoid);

const telemetryFixture = Effect.fn("test.resilienceTelemetry.fixture")(function*() {
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
      views: createAgentOSResilienceMetricViews(),
    });
    return { meterProvider, metrics, spans, tracerProvider };
  });
  const clockValues = [0, 250, 500, 1_000];
  const telemetry = yield* createAgentOSResilienceTelemetry({
    enabled: true,
    tracer: fixture.tracerProvider.getTracer("agentos-resilience-test"),
    meter: fixture.meterProvider.getMeter("agentos-resilience-test"),
    clock: Effect.sync(() => clockValues.shift() ?? 1_000),
  });
  return { ...fixture, telemetry };
});

describe("delegation and recovery telemetry runtime", () => {
  it.effect("correlates ordered protected observations under one operation", () =>
    Effect.gen(function*() {
      const fixture = yield* telemetryFixture();
      const operation = yield* fixture.telemetry.startOperation({
        agentId: AgentId,
        assignmentId: AssignmentId,
        operationId: OperationId,
      });
      yield* operation.observe(event("reconciliation"));
      yield* operation.observe(event("protocol"));
      yield* operation.end(event("outcome"));
      yield* operation.end(event("outcome"));
      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.forceFlush()),
        foreignPromise(() => fixture.meterProvider.forceFlush()),
      ], { concurrency: "unbounded", discard: true });

      const spans = fixture.spans.getFinishedSpans();
      expect(spans.map(({ name }) => name)).toEqual([
        "agentos.resilience.reconciliation",
        "agentos.resilience.protocol",
        "agentos.resilience.outcome",
        "agentos.resilience.operation",
      ]);
      const root = spans[3];
      for (const child of spans.slice(0, 3)) {
        expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      }
      expect(root?.attributes).toMatchObject({
        "agentos.identity.agent_id": AgentId,
        "agentos.identity.assignment_id": AssignmentId,
        "agentos.resilience.operation.id": OperationId,
        "agentos.resilience.outcome": "recovered",
      });

      const metricPayload = JSON.stringify(fixture.metrics.getMetrics());
      expect(metricPayload).toContain("agentos.resilience.observations");
      expect(metricPayload).toContain("agentos.resilience.operations");
      expect(metricPayload).toContain("agentos.resilience.operation.duration");
      expect(metricPayload).not.toContain(AgentId);
      expect(metricPayload).not.toContain(AssignmentId);
      expect(metricPayload).not.toContain(OperationId);
      expect(metricPayload).not.toContain("agentos.resilience.runtime.action");
      expect(metricPayload).not.toContain("agentos.resilience.attempt");
      expect(metricPayload).not.toContain("agentos.resilience.journal.phase");
      expect((metricPayload.match(/agentos.resilience.operations/g) ?? [])).toHaveLength(1);

      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.shutdown()),
        foreignPromise(() => fixture.meterProvider.shutdown()),
      ], { concurrency: "unbounded", discard: true });
    }),
  );

  it.effect("cannot let a failed diagnostic sink change recovery", () =>
    Effect.gen(function*() {
      const fixture = yield* telemetryFixture();
      const telemetry = yield* createAgentOSResilienceTelemetry({
        enabled: true,
        tracer: fixture.tracerProvider.getTracer("agentos-resilience-test"),
        meter: fixture.meterProvider.getMeter("agentos-resilience-test"),
        diagnostic: () => Effect.fail("collector unavailable"),
      });
      const operation = yield* telemetry.startOperation({
        agentId: AgentId,
        assignmentId: AssignmentId,
        operationId: OperationId,
      });

      const observed = yield* Effect.result(
        operation.observe(event("reconciliation")),
      );
      const ended = yield* Effect.result(operation.end(event("outcome")));
      expect(observed._tag).toBe("Success");
      expect(ended._tag).toBe("Success");

      yield* Effect.all([
        foreignPromise(() => fixture.tracerProvider.shutdown()),
        foreignPromise(() => fixture.meterProvider.shutdown()),
      ], { concurrency: "unbounded", discard: true });
    }),
  );

  it.effect("returns inert Effect scopes when disabled", () =>
    Effect.gen(function*() {
      const telemetry = createNoopAgentOSResilienceTelemetry();
      const operation = yield* telemetry.startOperation({
        agentId: AgentId,
        assignmentId: AssignmentId,
        operationId: OperationId,
      });
      yield* operation.observe(event("reconciliation"));
      yield* operation.end(event("outcome"));
      expect(telemetry.enabled).toBe(false);
    }),
  );
});
