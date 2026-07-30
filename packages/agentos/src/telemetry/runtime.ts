import { randomUUID } from "node:crypto";
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
  AGENTOS_AI_METRICS,
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
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
  safeTelemetryAttributes,
  type AgentOSTelemetryAttributes,
} from "./privacy.ts";

export interface AgentOSOperationInput {
  runtime: AgentOSAIRuntime;
  runtimeVersion?: string;
  route: AgentOSAIRoute;
  sessionState: AgentOSAISessionState;
  modelFamily: AgentOSAIModelFamily;
  providerFamily: AgentOSAIProviderFamily;
}

export interface AgentOSProviderAttemptInput {
  requestKind: AgentOSAIRequestKind;
  streamMode: AgentOSAIStreamMode;
  compactionPath?: AgentOSAICompactionPath;
  routeSlot?: string;
  retryCount?: number;
}

export interface AgentOSOperationOutcome {
  status?: number;
  error?: unknown;
}

export interface AgentOSProviderAttemptOutcome extends AgentOSOperationOutcome {
  streamOutcome?: AgentOSAIStreamOutcome;
  providerRequestId?: string;
  chunks?: number;
  bytes?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type AgentOSTraceCarrier =
  Headers | Readonly<Record<string, string | undefined>>;

export interface AgentOSProviderAttempt {
  readonly id: string;
  inject(carrier: Headers | Record<string, string>): void;
  end(outcome?: AgentOSProviderAttemptOutcome): void;
}

export interface AgentOSOperation {
  readonly id: string;
  startProviderAttempt(
    input: AgentOSProviderAttemptInput,
  ): AgentOSProviderAttempt;
  end(outcome?: AgentOSOperationOutcome): void;
}

export interface AgentOSTelemetry {
  readonly enabled: boolean;
  startOperation(
    input: AgentOSOperationInput,
    parentCarrier?: AgentOSTraceCarrier,
  ): AgentOSOperation;
  shutdown(): Promise<void>;
}

export interface AgentOSTelemetryOptions {
  enabled?: boolean;
  tracer?: Tracer;
  meter?: Meter;
  propagator?: TextMapPropagator;
  clock?: () => number;
  id?: () => string;
  shutdown?: () => Promise<void>;
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
      options: {
        boundaries: [...AGENTOS_AI_DURATION_BUCKETS_SECONDS],
      },
    },
  }));
}

interface Instruments {
  operations: Counter;
  providerAttempts: Counter;
  operationDuration: Histogram;
  providerDuration: Histogram;
}

const carrierGetter: TextMapGetter<Record<string, string>> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    return carrier[key];
  },
};

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

let environmentTelemetry: Promise<AgentOSTelemetry> | undefined;

export function createAgentOSTelemetry(
  options: AgentOSTelemetryOptions = {},
): AgentOSTelemetry {
  if (options.enabled === false) return createNoopAgentOSTelemetry();
  const tracer = options.tracer ?? trace.getTracer("@akua-dev/agentos");
  const meter = options.meter ?? metrics.getMeter("@akua-dev/agentos");
  const propagator = options.propagator ?? propagation;
  const clock = options.clock ?? monotonicMilliseconds;
  const id = options.id ?? randomUUID;
  const shutdown = options.shutdown ?? (async () => undefined);
  const instruments = createInstruments(meter);

  return {
    enabled: true,
    startOperation(input, parentCarrier) {
      try {
        const parentContext = extractParent(propagator, parentCarrier);
        const operationId = id();
        const startedAt = clock();
        const base = operationAttributes(input);
        const span = tracer.startSpan(
          "agentos.ai.operation",
          {
            attributes: safeTelemetryAttributes(
              {
                ...base,
                "agentos.ai.operation.id": operationId,
              },
              "span",
            ),
          },
          parentContext,
        );
        const operationContext = trace.setSpan(parentContext, span);
        let ended = false;

        return {
          id: operationId,
          startProviderAttempt(attemptInput) {
            return startProviderAttempt({
              attemptInput,
              base,
              clock,
              id,
              instruments,
              operationContext,
              propagator,
              tracer,
            });
          },
          end(outcome = {}) {
            if (ended) return;
            ended = true;
            const final = outcomeAttributes(outcome);
            finishSpan(span, final);
            record(() =>
              instruments.operations.add(
                1,
                safeTelemetryAttributes({ ...base, ...final }, "metric"),
              ),
            );
            record(() =>
              instruments.operationDuration.record(
                elapsedSeconds(startedAt, clock()),
                safeTelemetryAttributes({ ...base, ...final }, "metric"),
              ),
            );
          },
        };
      } catch {
        return noopOperation;
      }
    },
    async shutdown() {
      try {
        await shutdown();
      } catch {
        // Export shutdown is diagnostic-only and must remain fail-open.
      }
    },
  };
}

export function createNoopAgentOSTelemetry(): AgentOSTelemetry {
  return noopTelemetry;
}

export function initializeAgentOSTelemetryFromEnvironment(): Promise<AgentOSTelemetry> {
  if (environmentTelemetry) return environmentTelemetry;
  environmentTelemetry = initializeEnvironmentTelemetry();
  return environmentTelemetry;
}

function startProviderAttempt(options: {
  attemptInput: AgentOSProviderAttemptInput;
  base: AgentOSTelemetryAttributes;
  clock: () => number;
  id: () => string;
  instruments: Instruments;
  operationContext: Context;
  propagator: TextMapPropagator;
  tracer: Tracer;
}): AgentOSProviderAttempt {
  try {
    const attemptId = options.id();
    const startedAt = options.clock();
    const initial = {
      ...options.base,
      "agentos.ai.request.attempt_id": attemptId,
      "agentos.ai.request.kind": options.attemptInput.requestKind,
      "agentos.ai.stream.mode": options.attemptInput.streamMode,
      ...(options.attemptInput.compactionPath
        ? {
            "agentos.ai.compaction.path": options.attemptInput.compactionPath,
          }
        : {}),
      ...(options.attemptInput.routeSlot
        ? { "agentos.ai.route.slot": options.attemptInput.routeSlot }
        : {}),
      ...(options.attemptInput.retryCount !== undefined
        ? { "agentos.ai.retry.count": options.attemptInput.retryCount }
        : {}),
    };
    const span = options.tracer.startSpan(
      "agentos.ai.provider.attempt",
      { attributes: safeTelemetryAttributes(initial, "span") },
      options.operationContext,
    );
    const attemptContext = trace.setSpan(options.operationContext, span);
    let ended = false;

    return {
      id: attemptId,
      inject(carrier) {
        try {
          const injected: Record<string, string> = {};
          options.propagator.inject(attemptContext, injected, carrierSetter);
          if (options.base["agentos.ai.route"] === "ai_gateway") {
            injected["x-agentos-request-attempt-id"] = attemptId;
            injected["x-agentos-runtime"] = String(
              options.base["agentos.ai.runtime"] ?? "",
            );
            injected["x-agentos-request-kind"] =
              options.attemptInput.requestKind;
            injected["x-agentos-model-family"] = String(
              options.base["agentos.ai.model.family"] ?? "other",
            );
            injected["x-agentos-stream-mode"] = options.attemptInput.streamMode;
            injected["x-agentos-session-state"] = String(
              options.base["agentos.ai.session.state"] ?? "fresh",
            );
          }
          for (const [key, value] of Object.entries(injected)) {
            if (carrier instanceof Headers) carrier.set(key, value);
            else carrier[key] = value;
          }
        } catch {
          // Correlation is optional; the provider call must still proceed.
        }
      },
      end(outcome = {}) {
        if (ended) return;
        ended = true;
        const final = {
          ...outcomeAttributes(outcome),
          ...(outcome.streamOutcome
            ? { "agentos.ai.stream.outcome": outcome.streamOutcome }
            : {}),
          ...(outcome.providerRequestId
            ? {
                "agentos.ai.provider.request_id": outcome.providerRequestId,
              }
            : {}),
          ...(outcome.chunks !== undefined
            ? { "agentos.ai.stream.chunks": outcome.chunks }
            : {}),
          ...(outcome.bytes !== undefined
            ? { "agentos.ai.stream.bytes": outcome.bytes }
            : {}),
          ...(outcome.inputTokens !== undefined
            ? {
                "agentos.ai.usage.input_tokens": outcome.inputTokens,
              }
            : {}),
          ...(outcome.outputTokens !== undefined
            ? {
                "agentos.ai.usage.output_tokens": outcome.outputTokens,
              }
            : {}),
        };
        finishSpan(span, final);
        const metricAttributes = safeTelemetryAttributes(
          { ...initial, ...final },
          "metric",
        );
        record(() =>
          options.instruments.providerAttempts.add(1, metricAttributes),
        );
        record(() =>
          options.instruments.providerDuration.record(
            elapsedSeconds(startedAt, options.clock()),
            metricAttributes,
          ),
        );
      },
    };
  } catch {
    return noopAttempt;
  }
}

function createInstruments(meter: Meter): Instruments {
  return {
    operations: meter.createCounter(AGENTOS_AI_METRICS.operations, {
      unit: "{operation}",
      description: "Completed AgentOS AI operations",
    }),
    providerAttempts: meter.createCounter(AGENTOS_AI_METRICS.providerAttempts, {
      unit: "{attempt}",
      description: "Completed AgentOS AI provider attempts",
    }),
    operationDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.operationDuration,
      {
        unit: "s",
        description: "AgentOS AI operation duration",
      },
    ),
    providerDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.providerDuration,
      {
        unit: "s",
        description: "AgentOS AI provider-attempt duration",
      },
    ),
  };
}

function operationAttributes(
  input: AgentOSOperationInput,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes(
    {
      "agentos.telemetry.contract.version":
        AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
      "agentos.ai.runtime": input.runtime,
      ...(input.runtimeVersion
        ? { "agentos.ai.runtime.version": input.runtimeVersion }
        : {}),
      "agentos.ai.route": input.route,
      "agentos.ai.session.state": input.sessionState,
      "agentos.ai.model.family": input.modelFamily,
      "agentos.ai.provider.family": input.providerFamily,
    },
    "span",
  );
}

function outcomeAttributes(
  outcome: AgentOSOperationOutcome,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes(
    {
      "agentos.ai.status_class": classifyAIStatus(
        outcome.status,
        outcome.error,
      ),
      "agentos.ai.error.class": classifyAIError(outcome.error, outcome.status),
      ...(outcome.status !== undefined
        ? { "http.response.status_code": outcome.status }
        : {}),
    },
    "span",
  );
}

function finishSpan(span: Span, attributes: Readonly<Record<string, unknown>>) {
  record(() => {
    const safe = safeTelemetryAttributes(attributes, "span");
    span.setAttributes(safe);
    const statusClass = safe["agentos.ai.status_class"];
    span.setStatus({
      code:
        statusClass === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    span.end();
  });
}

function extractParent(
  propagator: TextMapPropagator,
  carrier?: AgentOSTraceCarrier,
): Context {
  if (!carrier) return context.active();
  const safe: Record<string, string> = {};
  for (const key of ["traceparent", "tracestate"] as const) {
    const value =
      carrier instanceof Headers
        ? (carrier.get(key) ?? undefined)
        : carrier[key];
    const maximum = key === "traceparent" ? 55 : 512;
    if (value && value.length <= maximum) safe[key] = value;
  }
  try {
    return propagator.extract(context.active(), safe, carrierGetter);
  } catch {
    return context.active();
  }
}

function record(operation: () => void) {
  try {
    operation();
  } catch {
    // Instrumentation is a best-effort diagnostic side effect.
  }
}

function monotonicMilliseconds(): number {
  return performance.now();
}

function elapsedSeconds(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt) / 1_000;
}

async function initializeEnvironmentTelemetry(): Promise<AgentOSTelemetry> {
  if (
    process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true" ||
    !hasExporterConfiguration(process.env)
  ) {
    return noopTelemetry;
  }
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const sdk = new NodeSDK({ views: createAgentOSMetricViews() });
    sdk.start();
    return createAgentOSTelemetry({
      enabled: true,
      shutdown: () => sdk.shutdown(),
    });
  } catch {
    return noopTelemetry;
  }
}

function hasExporterConfiguration(environment: NodeJS.ProcessEnv): boolean {
  const exporters = [
    environment.OTEL_TRACES_EXPORTER,
    environment.OTEL_METRICS_EXPORTER,
    environment.OTEL_LOGS_EXPORTER,
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (exporters.length > 0 && exporters.every((value) => value === "none")) {
    return false;
  }
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim(),
  );
}

const noopAttempt: AgentOSProviderAttempt = Object.freeze({
  id: "",
  inject() {},
  end() {},
});

const noopOperation: AgentOSOperation = Object.freeze({
  id: "",
  startProviderAttempt() {
    return noopAttempt;
  },
  end() {},
});

const noopTelemetry: AgentOSTelemetry = Object.freeze({
  enabled: false,
  startOperation() {
    return noopOperation;
  },
  async shutdown() {},
});
