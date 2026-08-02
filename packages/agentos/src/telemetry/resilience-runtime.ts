import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  AggregationType,
  InstrumentType,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { Clock, Effect, Ref } from "effect";

import { AGENTOS_AI_DURATION_BUCKETS_SECONDS } from "./contract.ts";
import {
  resilienceMetricAttributes,
  resilienceProtectedAttributes,
  type ResilienceObservationV1,
  type ResilienceProtectedCorrelationV1,
} from "./resilience-contract.ts";

export const AGENTOS_RESILIENCE_METRICS = Object.freeze({
  observations: "agentos.resilience.observations",
  operations: "agentos.resilience.operations",
  operationDuration: "agentos.resilience.operation.duration",
});

export interface AgentOSResilienceOperation {
  readonly observe: (
    observation: ResilienceObservationV1,
  ) => Effect.Effect<void>;
  readonly end: (
    observation: ResilienceObservationV1,
  ) => Effect.Effect<void>;
}

export interface AgentOSResilienceTelemetry {
  readonly enabled: boolean;
  readonly startOperation: (
    correlation: Pick<
      ResilienceProtectedCorrelationV1,
      "agentId" | "assignmentId" | "operationId"
    >,
  ) => Effect.Effect<AgentOSResilienceOperation>;
}

export interface AgentOSResilienceTelemetryOptions {
  readonly enabled?: boolean;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
  readonly clock?: Effect.Effect<number, unknown>;
  readonly diagnostic?: (
    observation: ResilienceObservationV1,
  ) => Effect.Effect<void, unknown>;
}

interface ResilienceInstruments {
  readonly observations: Counter;
  readonly operations: Counter;
  readonly operationDuration: Histogram;
}

export function createAgentOSResilienceMetricViews(): ViewOptions[] {
  return [
    {
      instrumentName: AGENTOS_RESILIENCE_METRICS.operationDuration,
      instrumentType: InstrumentType.HISTOGRAM,
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: {
          boundaries: [...AGENTOS_AI_DURATION_BUCKETS_SECONDS],
        },
      },
    },
  ];
}

const createTelemetryCore = Effect.fn(
  "agentos.resilienceTelemetry.create",
)(function*(options: AgentOSResilienceTelemetryOptions = {}) {
  if (options.enabled === false) return noopTelemetry;
  const configured = yield* Effect.try({
    try: () => {
      const tracer = options.tracer ?? trace.getTracer("@akua-dev/agentos");
      const meter = options.meter ?? metrics.getMeter("@akua-dev/agentos");
      return {
        tracer,
        instruments: createInstruments(meter),
      };
    },
    catch: () => undefined,
  });
  if (configured === undefined) return noopTelemetry;
  const clock = options.clock ?? Clock.currentTimeMillis;
  const diagnostic = options.diagnostic ?? (() => Effect.void);

  return {
    enabled: true,
    startOperation: (correlation) => startOperation({
      clock,
      correlation,
      diagnostic,
      instruments: configured.instruments,
      tracer: configured.tracer,
    }),
  } satisfies AgentOSResilienceTelemetry;
});

export function createAgentOSResilienceTelemetry(
  options?: AgentOSResilienceTelemetryOptions,
) {
  return createTelemetryCore(options).pipe(
    Effect.catchCause(() => Effect.succeed(noopTelemetry)),
  );
}

export function createNoopAgentOSResilienceTelemetry(): AgentOSResilienceTelemetry {
  return noopTelemetry;
}

const startOperationCore = Effect.fn(
  "agentos.resilienceTelemetry.startOperation",
)(function*(options: {
  readonly clock: Effect.Effect<number, unknown>;
  readonly correlation: Pick<
    ResilienceProtectedCorrelationV1,
    "agentId" | "assignmentId" | "operationId"
  >;
  readonly diagnostic: (
    observation: ResilienceObservationV1,
  ) => Effect.Effect<void, unknown>;
  readonly instruments: ResilienceInstruments;
  readonly tracer: Tracer;
}) {
  const startedAt = yield* options.clock;
  const parentContext = yield* Effect.try({
    try: () => context.active(),
    catch: () => undefined,
  });
  if (parentContext === undefined) return noopOperation;
  const root = yield* Effect.try({
    try: () => options.tracer.startSpan(
      "agentos.resilience.operation",
      { attributes: protectedCorrelationAttributes(options.correlation) },
      parentContext,
    ),
    catch: () => undefined,
  });
  if (root === undefined) return noopOperation;
  const operationContext = yield* Effect.try({
    try: () => trace.setSpan(parentContext, root),
    catch: () => undefined,
  });
  if (operationContext === undefined) {
    yield* endSpan(root);
    return noopOperation;
  }
  const ended = yield* Ref.make(false);

  const emit = (observation: ResilienceObservationV1) =>
    emitObservation({
      diagnostic: options.diagnostic,
      instruments: options.instruments,
      observation,
      operationContext,
      tracer: options.tracer,
    });

  return {
    observe: (observation) => Effect.gen(function*() {
      if (yield* Ref.get(ended)) return;
      if (!correlationMatches(options.correlation, observation.protected)) {
        return;
      }
      yield* emit(observation);
    }).pipe(Effect.catchCause(() => Effect.void)),
    end: (observation) => Effect.gen(function*() {
      if (yield* Ref.getAndSet(ended, true)) return;
      if (correlationMatches(options.correlation, observation.protected)) {
        yield* emit(observation);
        const protectedAttributes = resilienceProtectedAttributes(observation);
        const metricAttributes = resilienceMetricAttributes(observation);
        yield* record(() => root.setAttributes(protectedAttributes));
        yield* record(() => root.setStatus({
          code: statusCode(observation),
        }));
        yield* record(() => options.instruments.operations.add(
          1,
          metricAttributes,
        ));
        const endedAt = yield* options.clock;
        yield* record(() => options.instruments.operationDuration.record(
          Math.max(0, endedAt - startedAt) / 1_000,
          metricAttributes,
        ));
      }
      yield* endSpan(root);
    }).pipe(Effect.catchCause(() => endSpan(root))),
  } satisfies AgentOSResilienceOperation;
});

function startOperation(
  options: Parameters<typeof startOperationCore>[0],
) {
  return startOperationCore(options).pipe(
    Effect.catchCause(() => Effect.succeed(noopOperation)),
  );
}

const emitObservationCore = Effect.fn(
  "agentos.resilienceTelemetry.emitObservation",
)(function*(options: {
  readonly diagnostic: (
    observation: ResilienceObservationV1,
  ) => Effect.Effect<void, unknown>;
  readonly instruments: ResilienceInstruments;
  readonly observation: ResilienceObservationV1;
  readonly operationContext: Context;
  readonly tracer: Tracer;
}) {
  const protectedAttributes = resilienceProtectedAttributes(
    options.observation,
  );
  const metricAttributes = resilienceMetricAttributes(options.observation);
  const span = yield* Effect.try({
    try: () => options.tracer.startSpan(
      `agentos.resilience.${options.observation.phase}`,
      { attributes: protectedAttributes },
      options.operationContext,
    ),
    catch: () => undefined,
  });
  if (span !== undefined) {
    yield* record(() => span.setStatus({ code: statusCode(options.observation) }));
    yield* endSpan(span);
  }
  yield* record(() => options.instruments.observations.add(1, metricAttributes));
  yield* options.diagnostic(options.observation).pipe(
    Effect.catchCause(() => Effect.void),
  );
});

function emitObservation(
  options: Parameters<typeof emitObservationCore>[0],
) {
  return emitObservationCore(options).pipe(Effect.catchCause(() => Effect.void));
}

function createInstruments(meter: Meter): ResilienceInstruments {
  return {
    observations: meter.createCounter(
      AGENTOS_RESILIENCE_METRICS.observations,
      {
        unit: "{observation}",
        description: "Observed AgentOS resilience boundaries",
      },
    ),
    operations: meter.createCounter(
      AGENTOS_RESILIENCE_METRICS.operations,
      {
        unit: "{operation}",
        description: "Completed AgentOS resilience operations",
      },
    ),
    operationDuration: meter.createHistogram(
      AGENTOS_RESILIENCE_METRICS.operationDuration,
      {
        unit: "s",
        description: "AgentOS resilience operation duration",
      },
    ),
  };
}

function protectedCorrelationAttributes(
  correlation: Pick<
    ResilienceProtectedCorrelationV1,
    "agentId" | "assignmentId" | "operationId"
  >,
) {
  return {
    "agentos.identity.agent_id": correlation.agentId,
    "agentos.resilience.operation.id": correlation.operationId,
    ...(correlation.assignmentId === null
      ? {}
      : { "agentos.identity.assignment_id": correlation.assignmentId }),
  };
}

function correlationMatches(
  expected: Pick<
    ResilienceProtectedCorrelationV1,
    "agentId" | "assignmentId" | "operationId"
  >,
  observed: ResilienceProtectedCorrelationV1,
): boolean {
  return expected.agentId === observed.agentId &&
    expected.assignmentId === observed.assignmentId &&
    expected.operationId === observed.operationId;
}

function statusCode(observation: ResilienceObservationV1): SpanStatusCode {
  switch (observation.outcome) {
    case "succeeded":
    case "recovered":
      return SpanStatusCode.OK;
    case "failed":
    case "blocked":
    case "degraded":
      return SpanStatusCode.ERROR;
    case "pending":
    case "unobserved":
      return SpanStatusCode.UNSET;
  }
}

function endSpan(span: Span) {
  return record(() => span.end());
}

function record(operation: () => void) {
  return Effect.sync(operation).pipe(Effect.catchCause(() => Effect.void));
}

const noopOperation: AgentOSResilienceOperation = Object.freeze({
  observe: () => Effect.void,
  end: () => Effect.void,
});

const noopTelemetry: AgentOSResilienceTelemetry = Object.freeze({
  enabled: false,
  startOperation: () => Effect.succeed(noopOperation),
});
