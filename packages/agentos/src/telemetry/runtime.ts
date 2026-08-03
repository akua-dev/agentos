import {
  context,
  metrics,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type Tracer,
} from "@opentelemetry/api";
import {
  AggregationType,
  InstrumentType,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import {
  Clock,
  Config,
  Effect,
  Option,
  Ref,
} from "effect";

import {
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_AI_METRICS,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
  AGENTOS_TELEMETRY_SPANS,
  type AgentOSAICompactionPath,
  type AgentOSAIModelFamily,
  type AgentOSAIProviderFamily,
  type AgentOSAIRequestKind,
  type AgentOSAIRoute,
  type AgentOSAIRuntime,
  type AgentOSAISessionState,
  type AgentOSAIStreamMode,
  type AgentOSAIStreamOutcome,
} from "./contract.ts";
import {
  classifyAIError,
  classifyAIStatus,
  safeMetricAttributes,
  safeTelemetryAttributes,
  type AgentOSTelemetryAttributes,
} from "./privacy.ts";

export interface AgentOSOperationInput {
  readonly runtime: AgentOSAIRuntime;
  readonly runtimeVersion?: string;
  readonly route: AgentOSAIRoute;
  readonly sessionState: AgentOSAISessionState;
  readonly modelFamily: AgentOSAIModelFamily;
  readonly providerFamily: AgentOSAIProviderFamily;
}

export interface AgentOSProviderAttemptInput {
  readonly requestKind: AgentOSAIRequestKind;
  readonly streamMode: AgentOSAIStreamMode;
  readonly compactionPath?: AgentOSAICompactionPath;
  readonly routeSlot?: string;
  readonly retryCount?: number;
}

export interface AgentOSOperationOutcome {
  readonly status?: number;
  readonly error?: unknown;
}

export interface AgentOSProviderAttemptOutcome extends AgentOSOperationOutcome {
  readonly streamOutcome?: AgentOSAIStreamOutcome;
  readonly providerRequestId?: string;
  readonly chunks?: number;
  readonly bytes?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type AgentOSTraceCarrier =
  Headers | Readonly<Record<string, string | undefined>>;

export interface AgentOSProviderAttempt {
  readonly id: string;
  readonly inject: (
    carrier: Headers | Record<string, string>,
  ) => Effect.Effect<void>;
  readonly end: (
    outcome?: AgentOSProviderAttemptOutcome,
  ) => Effect.Effect<void>;
}

export interface AgentOSOperation {
  readonly id: string;
  readonly startProviderAttempt: (
    input: AgentOSProviderAttemptInput,
  ) => Effect.Effect<AgentOSProviderAttempt>;
  readonly end: (outcome?: AgentOSOperationOutcome) => Effect.Effect<void>;
}

export interface AgentOSTelemetry {
  readonly enabled: boolean;
  readonly startOperation: (
    input: AgentOSOperationInput,
    parentCarrier?: AgentOSTraceCarrier,
  ) => Effect.Effect<AgentOSOperation>;
  readonly shutdown: Effect.Effect<void>;
}

export interface AgentOSTelemetryOptions {
  readonly enabled?: boolean;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
  readonly propagator?: TextMapPropagator;
  readonly clock?: Effect.Effect<number>;
  readonly id?: Effect.Effect<string>;
  readonly shutdown?: Effect.Effect<void>;
}

export function createAgentOSMetricViews(): ViewOptions[] {
  return [
    AGENTOS_AI_METRICS.operationDuration,
    AGENTOS_AI_METRICS.providerDuration,
    AGENTOS_AI_METRICS.upstreamHeadersDuration,
    AGENTOS_AI_METRICS.firstByteDuration,
    AGENTOS_AI_METRICS.streamDuration,
    AGENTOS_AI_METRICS.routeAcquisitionDuration,
    AGENTOS_AI_METRICS.quotaObservationAge,
  ].map((instrumentName) => ({
    instrumentName,
    instrumentType: InstrumentType.HISTOGRAM,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [...AGENTOS_AI_DURATION_BUCKETS_SECONDS] },
    },
  }));
}

interface Instruments {
  readonly operations: Counter;
  readonly providerAttempts: Counter;
  readonly operationDuration: Histogram;
  readonly providerDuration: Histogram;
}

const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys: Object.keys,
  get: (carrier, key) => carrier[key],
};

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const createAgentOSTelemetryCore = Effect.fn(
  "agentos.telemetry.create",
)(function*(options: AgentOSTelemetryOptions = {}) {
  if (options.enabled === false) return noopTelemetry;
  const clockService = yield* Clock.Clock;
  const clock = options.clock ?? Effect.sync(() => clockService.currentTimeMillisUnsafe());
  const id = options.id ?? Effect.sync(() => globalThis.crypto.randomUUID());
  const configured = yield* Effect.try({
    try: () => {
      const tracer = options.tracer ?? trace.getTracer("@akua-dev/agentos");
      const meter = options.meter ?? metrics.getMeter("@akua-dev/agentos");
      return {
        tracer,
        meter,
        propagator: options.propagator ?? propagation,
        instruments: createInstruments(meter),
      };
    },
    catch: () => undefined,
  });
  if (configured === undefined) return noopTelemetry;

  return {
    enabled: true,
    startOperation: (input, parentCarrier) =>
      startOperation({
        clock,
        id,
        input,
        instruments: configured.instruments,
        parentCarrier,
        propagator: configured.propagator,
        tracer: configured.tracer,
      }),
    shutdown: (options.shutdown ?? Effect.void).pipe(
      Effect.catchCause(() => Effect.void),
    ),
  } satisfies AgentOSTelemetry;
});

export function createAgentOSTelemetry(options?: AgentOSTelemetryOptions) {
  return createAgentOSTelemetryCore(options).pipe(
    Effect.catchCause(() => Effect.succeed(noopTelemetry)),
  );
}

export function createNoopAgentOSTelemetry(): AgentOSTelemetry {
  return noopTelemetry;
}

const TelemetryEnvironmentConfig = Config.all({
  disabled: Config.option(Config.string("OTEL_SDK_DISABLED")),
  endpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
  tracesEndpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")),
  metricsEndpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")),
  logsEndpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")),
  tracesExporter: Config.option(Config.string("OTEL_TRACES_EXPORTER")),
  metricsExporter: Config.option(Config.string("OTEL_METRICS_EXPORTER")),
  logsExporter: Config.option(Config.string("OTEL_LOGS_EXPORTER")),
});

const initializeAgentOSTelemetryFromEnvironmentCore = Effect.fn(
  "agentos.telemetry.initializeEnvironment",
)(function*() {
  const environment = yield* TelemetryEnvironmentConfig;
  if (
    Option.getOrUndefined(environment.disabled)?.trim().toLowerCase() === "true" ||
    !hasExporterConfiguration(environment)
  ) return noopTelemetry;

  const sdkModule = yield* Effect.tryPromise({
    try: () => import("@opentelemetry/sdk-node"),
    catch: () => undefined,
  }).pipe(Effect.option);
  if (Option.isNone(sdkModule)) return noopTelemetry;
  const sdk = yield* Effect.try({
    try: () => new sdkModule.value.NodeSDK({ views: createAgentOSMetricViews() }),
    catch: () => undefined,
  });
  if (sdk === undefined) return noopTelemetry;
  const started = yield* Effect.tryPromise({
    try: () => Promise.resolve(sdk.start()),
    catch: () => undefined,
  }).pipe(Effect.option);
  if (Option.isNone(started)) return noopTelemetry;
  return yield* createAgentOSTelemetry({
    enabled: true,
    shutdown: Effect.tryPromise({
      try: () => sdk.shutdown(),
      catch: () => undefined,
    }).pipe(Effect.ignore),
  });
});

export function initializeAgentOSTelemetryFromEnvironment() {
  return initializeAgentOSTelemetryFromEnvironmentCore().pipe(
    Effect.catchCause(() => Effect.succeed(noopTelemetry)),
  );
}

const startOperationCore = Effect.fn("agentos.telemetry.startOperation")(
  function*(options: {
    readonly clock: Effect.Effect<number>;
    readonly id: Effect.Effect<string, unknown>;
    readonly input: AgentOSOperationInput;
    readonly instruments: Instruments;
    readonly parentCarrier?: AgentOSTraceCarrier;
    readonly propagator: TextMapPropagator;
    readonly tracer: Tracer;
  }) {
    const parentContext = yield* extractParent(options.propagator, options.parentCarrier);
    const operationId = yield* options.id;
    const startedAt = yield* options.clock;
    const base = operationAttributes(options.input);
    const span = yield* Effect.try({
      try: () => options.tracer.startSpan(
        AGENTOS_TELEMETRY_SPANS.aiOperation,
        { attributes: safeTelemetryAttributes({ ...base, "agentos.ai.operation.id": operationId }, "span") },
        parentContext,
      ),
      catch: () => undefined,
    });
    if (span === undefined) return noopOperation;
    const operationContext = yield* Effect.try({
      try: () => trace.setSpan(parentContext, span),
      catch: () => undefined,
    });
    if (operationContext === undefined) return noopOperation;
    const ended = yield* Ref.make(false);
    return {
      id: operationId,
      startProviderAttempt: (attemptInput) => startProviderAttempt({
        attemptInput,
        base,
        clock: options.clock,
        id: options.id,
        instruments: options.instruments,
        operationContext,
        propagator: options.propagator,
        tracer: options.tracer,
      }),
      end: (outcome = {}) => Effect.gen(function*() {
        if (yield* Ref.getAndSet(ended, true)) return;
        const final = outcomeAttributes(outcome);
        yield* finishSpan(span, final);
        const metricInput = { ...base, ...final };
        yield* record(() => options.instruments.operations.add(
          1,
          safeMetricAttributes(AGENTOS_AI_METRICS.operations, metricInput),
        ));
        const endedAt = yield* options.clock;
        yield* record(() => options.instruments.operationDuration.record(
          elapsedSeconds(startedAt, endedAt),
          safeMetricAttributes(
            AGENTOS_AI_METRICS.operationDuration,
            metricInput,
          ),
        ));
      }),
    } satisfies AgentOSOperation;
  },
);

function startOperation(
  options: Parameters<typeof startOperationCore>[0],
) {
  return startOperationCore(options).pipe(
    Effect.catchCause(() => Effect.succeed(noopOperation)),
  );
}

const startProviderAttemptCore = Effect.fn("agentos.telemetry.startProviderAttempt")(
  function*(options: {
    readonly attemptInput: AgentOSProviderAttemptInput;
    readonly base: AgentOSTelemetryAttributes;
    readonly clock: Effect.Effect<number>;
    readonly id: Effect.Effect<string, unknown>;
    readonly instruments: Instruments;
    readonly operationContext: Context;
    readonly propagator: TextMapPropagator;
    readonly tracer: Tracer;
  }) {
    const attemptId = yield* options.id;
    const startedAt = yield* options.clock;
    const initial = {
      ...options.base,
      "agentos.ai.request.attempt_id": attemptId,
      "agentos.ai.request.kind": options.attemptInput.requestKind,
      "agentos.ai.stream.mode": options.attemptInput.streamMode,
      ...(options.attemptInput.compactionPath ? { "agentos.ai.compaction.path": options.attemptInput.compactionPath } : {}),
      ...(options.attemptInput.routeSlot ? { "agentos.ai.route.slot": options.attemptInput.routeSlot } : {}),
      ...(options.attemptInput.retryCount !== undefined ? { "agentos.ai.retry.count": options.attemptInput.retryCount } : {}),
    };
    const span = yield* Effect.try({
      try: () => options.tracer.startSpan(
        AGENTOS_TELEMETRY_SPANS.aiProviderAttempt,
        { attributes: safeTelemetryAttributes(initial, "span") },
        options.operationContext,
      ),
      catch: () => undefined,
    });
    if (span === undefined) return noopAttempt;
    const attemptContext = yield* Effect.try({
      try: () => trace.setSpan(options.operationContext, span),
      catch: () => undefined,
    });
    if (attemptContext === undefined) return noopAttempt;
    const ended = yield* Ref.make(false);
    return {
      id: attemptId,
      inject: (carrier) => Effect.sync(() => {
        const injected: Record<string, string> = {};
        options.propagator.inject(attemptContext, injected, carrierSetter);
        if (options.base["agentos.ai.route"] === "ai_gateway") {
          injected["x-agentos-request-attempt-id"] = attemptId;
          injected["x-agentos-runtime"] = String(options.base["agentos.ai.runtime"] ?? "");
          injected["x-agentos-request-kind"] = options.attemptInput.requestKind;
          injected["x-agentos-model-family"] = String(options.base["agentos.ai.model.family"] ?? "other");
          injected["x-agentos-stream-mode"] = options.attemptInput.streamMode;
          injected["x-agentos-session-state"] = String(options.base["agentos.ai.session.state"] ?? "fresh");
        }
        for (const [key, value] of Object.entries(injected)) {
          if (carrier instanceof Headers) carrier.set(key, value);
          else carrier[key] = value;
        }
      }).pipe(Effect.catchCause(() => Effect.void)),
      end: (outcome = {}) => Effect.gen(function*() {
        if (yield* Ref.getAndSet(ended, true)) return;
        const final = {
          ...outcomeAttributes(outcome),
          ...(outcome.streamOutcome ? { "agentos.ai.stream.outcome": outcome.streamOutcome } : {}),
          ...(outcome.providerRequestId ? { "agentos.ai.provider.request_id": outcome.providerRequestId } : {}),
          ...(outcome.chunks !== undefined ? { "agentos.ai.stream.chunks": outcome.chunks } : {}),
          ...(outcome.bytes !== undefined ? { "agentos.ai.stream.bytes": outcome.bytes } : {}),
          ...(outcome.inputTokens !== undefined ? { "agentos.ai.usage.input_tokens": outcome.inputTokens } : {}),
          ...(outcome.outputTokens !== undefined ? { "agentos.ai.usage.output_tokens": outcome.outputTokens } : {}),
        };
        yield* finishSpan(span, final);
        const metricInput = { ...initial, ...final };
        yield* record(() => options.instruments.providerAttempts.add(
          1,
          safeMetricAttributes(
            AGENTOS_AI_METRICS.providerAttempts,
            metricInput,
          ),
        ));
        const endedAt = yield* options.clock;
        yield* record(() => options.instruments.providerDuration.record(
          elapsedSeconds(startedAt, endedAt),
          safeMetricAttributes(
            AGENTOS_AI_METRICS.providerDuration,
            metricInput,
          ),
        ));
      }),
    } satisfies AgentOSProviderAttempt;
  },
);

function startProviderAttempt(
  options: Parameters<typeof startProviderAttemptCore>[0],
) {
  return startProviderAttemptCore(options).pipe(
    Effect.catchCause(() => Effect.succeed(noopAttempt)),
  );
}

function createInstruments(meter: Meter): Instruments {
  return {
    operations: meter.createCounter(AGENTOS_AI_METRICS.operations, { unit: "{operation}", description: "Completed AgentOS AI operations" }),
    providerAttempts: meter.createCounter(AGENTOS_AI_METRICS.providerAttempts, { unit: "{attempt}", description: "Completed AgentOS AI provider attempts" }),
    operationDuration: meter.createHistogram(AGENTOS_AI_METRICS.operationDuration, { unit: "s", description: "AgentOS AI operation duration" }),
    providerDuration: meter.createHistogram(AGENTOS_AI_METRICS.providerDuration, { unit: "s", description: "AgentOS AI provider-attempt duration" }),
  };
}

function operationAttributes(input: AgentOSOperationInput): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
    "agentos.telemetry.contract.version": AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
    "agentos.ai.runtime": input.runtime,
    ...(input.runtimeVersion ? { "agentos.ai.runtime.version": input.runtimeVersion } : {}),
    "agentos.ai.route": input.route,
    "agentos.ai.session.state": input.sessionState,
    "agentos.ai.model.family": input.modelFamily,
    "agentos.ai.provider.family": input.providerFamily,
  }, "span");
}

function outcomeAttributes(outcome: AgentOSOperationOutcome): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
    "agentos.ai.status_class": classifyAIStatus(outcome.status, outcome.error),
    "agentos.ai.error.class": classifyAIError(outcome.error, outcome.status),
    ...(outcome.status !== undefined ? { "http.response.status_code": outcome.status } : {}),
  }, "span");
}

function finishSpan(span: Span, attributes: Readonly<Record<string, unknown>>) {
  return record(() => {
    const safe = safeTelemetryAttributes(attributes, "span");
    span.setAttributes(safe);
    span.setStatus({ code: safe["agentos.ai.status_class"] === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  });
}

const extractParent = Effect.fn("agentos.telemetry.extractParent")(
  function*(propagator: TextMapPropagator, carrier?: AgentOSTraceCarrier) {
    if (!carrier) return context.active();
    const safe: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate"] satisfies ReadonlyArray<string>) {
      const value = carrier instanceof Headers ? (carrier.get(key) ?? undefined) : carrier[key];
      const maximum = key === "traceparent" ? 55 : 512;
      if (value && value.length <= maximum) safe[key] = value;
    }
    return yield* Effect.try({
      try: () => propagator.extract(context.active(), safe, carrierGetter),
      catch: () => context.active(),
    });
  },
);

function record(operation: () => void) {
  return Effect.sync(operation).pipe(Effect.catchCause(() => Effect.void));
}

function elapsedSeconds(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt) / 1_000;
}

type TelemetryEnvironment = Config.Success<typeof TelemetryEnvironmentConfig>;

function hasExporterConfiguration(environment: TelemetryEnvironment): boolean {
  const exporters = [environment.tracesExporter, environment.metricsExporter, environment.logsExporter]
    .flatMap((value) => Option.getOrUndefined(value)?.split(",") ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (exporters.length > 0 && exporters.every((value) => value === "none")) return false;
  return [environment.endpoint, environment.tracesEndpoint, environment.metricsEndpoint, environment.logsEndpoint]
    .some((value) => Boolean(Option.getOrUndefined(value)?.trim()));
}

const noopAttempt: AgentOSProviderAttempt = Object.freeze({
  id: "",
  inject: () => Effect.void,
  end: () => Effect.void,
});

const noopOperation: AgentOSOperation = Object.freeze({
  id: "",
  startProviderAttempt: () => Effect.succeed(noopAttempt),
  end: () => Effect.void,
});

const noopTelemetry: AgentOSTelemetry = Object.freeze({
  enabled: false,
  startOperation: () => Effect.succeed(noopOperation),
  shutdown: Effect.void,
});
