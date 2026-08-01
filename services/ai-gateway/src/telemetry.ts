import { randomUUID } from "node:crypto";
import {
  context,
  metrics,
  propagation,
  SpanKind,
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
  type UpDownCounter,
} from "@opentelemetry/api";
import {
  AGENTOS_AI_METRICS,
  AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
  classifyAIError,
  classifyAIStatus,
  safeTelemetryAttributes,
  type AgentOSAIModelFamily,
  type AgentOSAIRequestKind,
  type AgentOSAIRuntime,
  type AgentOSAISessionState,
  type AgentOSAIStreamMode,
  type AgentOSAIStreamOutcome,
  type AgentOSTelemetryAttributes,
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";

export type GatewayRouteOutcome = "acquired" | "unavailable" | "error";

export interface GatewayRequestOutcome {
  status?: number;
  error?: unknown;
  streamOutcome: AgentOSAIStreamOutcome;
}

export interface GatewayRequestTelemetry {
  readonly attemptId: string;
  authenticate(
    authenticated: boolean,
    authorization?: ProviderAuthorizationGrantV1,
    failureStatus?: 401 | 403,
  ): void;
  routeStarted(): void;
  routeEnded(outcome: GatewayRouteOutcome, error?: unknown): void;
  quotaObservation(ageSeconds: number, stale: boolean): void;
  upstreamStarted(headers: Headers): void;
  upstreamHeaders(status: number, headers: Headers): void;
  upstreamFailed(error: unknown): void;
  streamChunk(bytes: number): void;
  routeReleaseStarted(): void;
  routeReleased(error?: unknown): void;
  end(outcome: GatewayRequestOutcome): void;
}

export interface GatewayTelemetry {
  readonly enabled: boolean;
  startRequest(request: Request): GatewayRequestTelemetry;
}

export interface GatewayTelemetryOptions {
  enabled?: boolean;
  tracer?: Tracer;
  meter?: Meter;
  propagator?: TextMapPropagator;
  clock?: () => number;
  id?: () => string;
  log?: (record: Readonly<Record<string, string | number>>) => void;
}

interface Instruments {
  operations: Counter;
  providerAttempts: Counter;
  operationDuration: Histogram;
  providerDuration: Histogram;
  upstreamHeadersDuration: Histogram;
  firstByteDuration: Histogram;
  streamDuration: Histogram;
  activeStreams: UpDownCounter;
  streamChunks: Counter;
  streamBytes: Counter;
  routeAcquisitionDuration: Histogram;
  quotaObservationAge: Histogram;
}

const getter: TextMapGetter<Record<string, string>> = {
  keys: Object.keys,
  get: (carrier, key) => carrier[key],
};

const setter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function createGatewayTelemetry(
  options: GatewayTelemetryOptions = {},
): GatewayTelemetry {
  if (options.enabled === false) return createNoopGatewayTelemetry();
  const tracer = options.tracer ?? trace.getTracer("@agentos/ai-gateway");
  const meter = options.meter ?? metrics.getMeter("@agentos/ai-gateway");
  const propagator = options.propagator ?? propagation;
  const clock = options.clock ?? (() => performance.now());
  const id = options.id ?? randomUUID;
  const log = options.log ?? logFailure;
  const instruments = createInstruments(meter);

  return {
    enabled: true,
    startRequest(request) {
      try {
        return startGatewayRequest({
          request,
          tracer,
          meter,
          propagator,
          clock,
          id,
          log,
          instruments,
        });
      } catch {
        return noopRequest;
      }
    },
  };
}

export function createNoopGatewayTelemetry(): GatewayTelemetry {
  return noopTelemetry;
}

function startGatewayRequest(options: {
  request: Request;
  tracer: Tracer;
  meter: Meter;
  propagator: TextMapPropagator;
  clock: () => number;
  id: () => string;
  log: (record: Readonly<Record<string, string | number>>) => void;
  instruments: Instruments;
}): GatewayRequestTelemetry {
  const parentContext = extractParent(
    options.request.headers,
    options.propagator,
  );
  const requestId = options.id();
  let base = requestAttributes(options.request.headers, requestId);
  const requestStartedAt = options.clock();
  const requestSpan = options.tracer.startSpan(
    "ai-gateway.request",
    {
      kind: SpanKind.SERVER,
      attributes: safeTelemetryAttributes(base, "span"),
    },
    parentContext,
  );
  const requestContext = trace.setSpan(parentContext, requestSpan);
  let routeSpan: Span | undefined;
  let routeStartedAt: number | undefined;
  let releaseSpan: Span | undefined;
  let upstreamSpan: Span | undefined;
  let upstreamContext: Context | undefined;
  let upstreamStartedAt: number | undefined;
  let upstreamStatus: number | undefined;
  let providerRequestId: string | undefined;
  let attemptId = "";
  let streamSpan: Span | undefined;
  let streamStartedAt: number | undefined;
  let firstByteRecorded = false;
  let streamActive = false;
  let chunks = 0;
  let bytes = 0;
  let ended = false;

  const metricBase = () => safeTelemetryAttributes(base, "metric");
  const spanBase = () => safeTelemetryAttributes(base, "span");

  return {
    get attemptId() {
      return attemptId;
    },
    authenticate(authenticated, authorization, failureStatus) {
      safely(() => {
        const attribution = authorization === undefined
          ? {}
          : authorizationTelemetryAttributes(authorization);
        if (authenticated && authorization !== undefined) {
          base = safeTelemetryAttributes({ ...base, ...attribution }, "span");
          requestSpan.setAttributes(
            safeTelemetryAttributes(attribution, "span"),
          );
        }
        const span = options.tracer.startSpan(
          "ai-gateway.authenticate",
          undefined,
          requestContext,
        );
        const attributes = safeTelemetryAttributes({
          ...attribution,
          ...outcomeAttributes(
            authenticated ? 200 : (failureStatus ?? 401),
            undefined,
          ),
        }, "span");
        span.setAttributes(attributes);
        finishSpan(span, attributes);
      });
    },
    routeStarted() {
      safely(() => {
        if (routeSpan) return;
        routeStartedAt = options.clock();
        routeSpan = options.tracer.startSpan(
          "ai-gateway.route.acquire",
          undefined,
          requestContext,
        );
      });
    },
    routeEnded(outcome, error) {
      safely(() => {
        if (!routeSpan) return;
        const status = outcome === "acquired" ? 200 : 503;
        const attributes = outcomeAttributes(status, error);
        finishSpan(routeSpan, attributes);
        if (routeStartedAt !== undefined) {
          options.instruments.routeAcquisitionDuration.record(
            elapsed(routeStartedAt, options.clock()),
            safeTelemetryAttributes({ ...base, ...attributes }, "metric"),
          );
        }
        routeSpan = undefined;
      });
    },
    quotaObservation(ageSeconds, stale) {
      safely(() => {
        options.instruments.quotaObservationAge.record(
          boundedQuotaObservationAge(ageSeconds),
          safeTelemetryAttributes(
            { ...base, "agentos.ai.quota.stale": stale },
            "metric",
          ),
        );
      });
    },
    upstreamStarted(headers) {
      safely(() => {
        if (upstreamSpan) return;
        attemptId = options.id();
        upstreamStartedAt = options.clock();
        upstreamSpan = options.tracer.startSpan(
          "ai-gateway.upstream",
          {
            kind: SpanKind.CLIENT,
            attributes: safeTelemetryAttributes(
              {
                ...base,
                "agentos.ai.request.attempt_id": attemptId,
              },
              "span",
            ),
          },
          requestContext,
        );
        upstreamContext = trace.setSpan(requestContext, upstreamSpan);
        const carrier: Record<string, string> = {};
        options.propagator.inject(upstreamContext, carrier, setter);
        for (const [key, value] of Object.entries(carrier)) {
          headers.set(key, value);
        }
        headers.set("x-client-request-id", attemptId);
      });
    },
    upstreamHeaders(status, headers) {
      safely(() => {
        upstreamStatus = status;
        providerRequestId = safeProviderRequestId(headers);
        if (upstreamStartedAt !== undefined) {
          options.instruments.upstreamHeadersDuration.record(
            elapsed(upstreamStartedAt, options.clock()),
            safeTelemetryAttributes(
              { ...base, ...outcomeAttributes(status) },
              "metric",
            ),
          );
        }
        if (upstreamSpan) {
          upstreamSpan.setAttributes(
            safeTelemetryAttributes(
              {
                ...outcomeAttributes(status),
                ...(providerRequestId
                  ? {
                      "agentos.ai.provider.request_id": providerRequestId,
                    }
                  : {}),
              },
              "span",
            ),
          );
        }
        startStream();
      });
    },
    upstreamFailed(error) {
      safely(() => {
        upstreamStatus = undefined;
        if (upstreamSpan) {
          upstreamSpan.setAttributes(outcomeAttributes(undefined, error));
        }
      });
    },
    streamChunk(size) {
      safely(() => {
        startStream();
        if (
          !firstByteRecorded &&
          upstreamStartedAt !== undefined &&
          Number.isFinite(size) &&
          size >= 0
        ) {
          firstByteRecorded = true;
          options.instruments.firstByteDuration.record(
            elapsed(upstreamStartedAt, options.clock()),
            metricBase(),
          );
        }
        chunks = boundedAdd(chunks, 1);
        bytes = boundedAdd(bytes, size);
      });
    },
    routeReleaseStarted() {
      safely(() => {
        if (releaseSpan) return;
        releaseSpan = options.tracer.startSpan(
          "ai-gateway.route.release",
          undefined,
          requestContext,
        );
      });
    },
    routeReleased(error) {
      safely(() => {
        if (!releaseSpan) return;
        finishSpan(releaseSpan, outcomeAttributes(error ? 500 : 200, error));
        releaseSpan = undefined;
      });
    },
    end(outcome) {
      safely(() => {
        if (ended) return;
        ended = true;
        const final = {
          ...outcomeAttributes(outcome.status, outcome.error),
          "agentos.ai.stream.outcome": outcome.streamOutcome,
        };
        if (routeSpan) {
          finishSpan(routeSpan, outcomeAttributes(503, outcome.error));
          routeSpan = undefined;
        }
        if (releaseSpan) {
          finishSpan(releaseSpan, outcomeAttributes(500, outcome.error));
          releaseSpan = undefined;
        }
        if (streamSpan) {
          const streamAttributes = safeTelemetryAttributes(
            {
              ...final,
              "agentos.ai.stream.chunks": chunks,
              "agentos.ai.stream.bytes": bytes,
            },
            "span",
          );
          finishSpan(streamSpan, streamAttributes);
          if (streamStartedAt !== undefined) {
            options.instruments.streamDuration.record(
              elapsed(streamStartedAt, options.clock()),
              safeTelemetryAttributes({ ...base, ...final }, "metric"),
            );
          }
          options.instruments.streamChunks.add(
            chunks,
            safeTelemetryAttributes({ ...base, ...final }, "metric"),
          );
          options.instruments.streamBytes.add(
            bytes,
            safeTelemetryAttributes({ ...base, ...final }, "metric"),
          );
          if (streamActive) {
            options.instruments.activeStreams.add(-1, metricBase());
            streamActive = false;
          }
        }
        if (upstreamSpan) {
          const upstreamFinal = safeTelemetryAttributes(
            {
              ...final,
              "agentos.ai.request.attempt_id": attemptId,
              ...(providerRequestId
                ? {
                    "agentos.ai.provider.request_id": providerRequestId,
                  }
                : {}),
            },
            "span",
          );
          finishSpan(upstreamSpan, upstreamFinal);
          const providerMetricAttributes = safeTelemetryAttributes(
            { ...base, ...final },
            "metric",
          );
          options.instruments.providerAttempts.add(1, providerMetricAttributes);
          if (upstreamStartedAt !== undefined) {
            options.instruments.providerDuration.record(
              elapsed(upstreamStartedAt, options.clock()),
              providerMetricAttributes,
            );
          }
        }
        const operationMetricAttributes = safeTelemetryAttributes(
          { ...base, ...final },
          "metric",
        );
        options.instruments.operations.add(1, operationMetricAttributes);
        options.instruments.operationDuration.record(
          elapsed(requestStartedAt, options.clock()),
          operationMetricAttributes,
        );
        finishSpan(requestSpan, final);
        if (
          outcome.error !== undefined ||
          classifyAIStatus(outcome.status, outcome.error) !== "success"
        ) {
          safely(() =>
            options.log(
              correlatedFailureRecord({
                base,
                attemptId,
                span: upstreamSpan ?? requestSpan,
                status: outcome.status,
                error: outcome.error,
                streamOutcome: outcome.streamOutcome,
              }),
            ),
          );
        }
      });
    },
  };

  function startStream() {
    if (streamSpan) return;
    streamStartedAt = options.clock();
    streamSpan = options.tracer.startSpan(
      "ai-gateway.stream",
      { attributes: spanBase() },
      upstreamContext ?? requestContext,
    );
    options.instruments.activeStreams.add(1, metricBase());
    streamActive = true;
  }
}

function authorizationTelemetryAttributes(
  authorization: ProviderAuthorizationGrantV1,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
    "agentos.identity.agent_id": authorization.identity.agentId,
    ...(authorization.identity.assignmentId === null
      ? {}
      : {
          "agentos.identity.assignment_id":
            authorization.identity.assignmentId,
        }),
    "agentos.authz.decision_ref": authorization.decisionRef,
    "agentos.authz.profile_id": authorization.profile.profileId,
    "agentos.authz.profile_version": authorization.profile.profileVersion,
    "agentos.authz.rate_class": authorization.rateClass,
  }, "span");
}

function createInstruments(meter: Meter): Instruments {
  return {
    operations: meter.createCounter(AGENTOS_AI_METRICS.operations),
    providerAttempts: meter.createCounter(AGENTOS_AI_METRICS.providerAttempts),
    operationDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.operationDuration,
      { unit: "s" },
    ),
    providerDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.providerDuration,
      { unit: "s" },
    ),
    upstreamHeadersDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.upstreamHeadersDuration,
      { unit: "s" },
    ),
    firstByteDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.firstByteDuration,
      { unit: "s" },
    ),
    streamDuration: meter.createHistogram(AGENTOS_AI_METRICS.streamDuration, {
      unit: "s",
    }),
    activeStreams: meter.createUpDownCounter(AGENTOS_AI_METRICS.activeStreams, {
      unit: "{stream}",
    }),
    streamChunks: meter.createCounter(AGENTOS_AI_METRICS.streamChunks, {
      unit: "{chunk}",
    }),
    streamBytes: meter.createCounter(AGENTOS_AI_METRICS.streamBytes, {
      unit: "By",
    }),
    routeAcquisitionDuration: meter.createHistogram(
      AGENTOS_AI_METRICS.routeAcquisitionDuration,
      { unit: "s" },
    ),
    quotaObservationAge: meter.createHistogram(
      AGENTOS_AI_METRICS.quotaObservationAge,
      { unit: "s" },
    ),
  };
}

function requestAttributes(
  headers: Headers,
  requestId: string,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes(
    {
      "agentos.telemetry.contract.version":
        AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
      "agentos.ai.runtime": boundedHeader<AgentOSAIRuntime>(
        headers,
        "x-agentos-runtime",
        ["pi", "codex"],
        inferRuntime(headers),
      ),
      "agentos.ai.route": "ai_gateway",
      "agentos.ai.provider.family": "openai",
      "agentos.ai.request.kind": boundedHeader<AgentOSAIRequestKind>(
        headers,
        "x-agentos-request-kind",
        [
          "main",
          "compaction",
          "memory_extract",
          "memory_consolidate",
          "extension",
        ],
        "main",
      ),
      "agentos.ai.model.family": boundedHeader<AgentOSAIModelFamily>(
        headers,
        "x-agentos-model-family",
        ["gpt-5", "gpt-4.1", "o-series", "other"],
        "other",
      ),
      "agentos.ai.stream.mode": boundedHeader<AgentOSAIStreamMode>(
        headers,
        "x-agentos-stream-mode",
        ["streaming", "non_streaming"],
        "streaming",
      ),
      "agentos.ai.session.state": boundedHeader<AgentOSAISessionState>(
        headers,
        "x-agentos-session-state",
        ["fresh", "resumed"],
        "fresh",
      ),
      "agentos.ai.operation.id": requestId,
    },
    "span",
  );
}

function boundedHeader<T extends string>(
  headers: Headers,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = headers.get(name)?.trim();
  return values.find((candidate) => candidate === value) ?? fallback;
}

function inferRuntime(headers: Headers): AgentOSAIRuntime {
  return /\bcodex\b/i.test(headers.get("user-agent") ?? "") ? "codex" : "pi";
}

function outcomeAttributes(
  status?: number,
  error?: unknown,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes(
    {
      "agentos.ai.status_class": classifyAIStatus(status, error),
      "agentos.ai.error.class": classifyAIError(error, status),
      ...(status === undefined ? {} : { "http.response.status_code": status }),
    },
    "span",
  );
}

function finishSpan(span: Span, attributes: Readonly<Record<string, unknown>>) {
  const safe = safeTelemetryAttributes(attributes, "span");
  span.setAttributes(safe);
  span.setStatus({
    code:
      safe["agentos.ai.status_class"] === "success"
        ? SpanStatusCode.OK
        : SpanStatusCode.ERROR,
  });
  span.end();
}

function extractParent(
  headers: Headers,
  propagator: TextMapPropagator,
): Context {
  const carrier: Record<string, string> = {};
  const propagationHeaders: ReadonlyArray<readonly [string, number]> = [
    ["traceparent", 55],
    ["tracestate", 512],
  ];
  for (const [name, maximum] of propagationHeaders) {
    const value = headers.get(name);
    if (value && value.length <= maximum) carrier[name] = value;
  }
  try {
    return propagator.extract(context.active(), carrier, getter);
  } catch {
    return context.active();
  }
}

function safeProviderRequestId(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "x-oai-request-id"]) {
    const value = headers.get(name)?.trim();
    if (value && value.length <= 128 && /^[0-9A-Za-z_.:-]+$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

function correlatedFailureRecord(input: {
  base: AgentOSTelemetryAttributes;
  attemptId: string;
  span: Span;
  status?: number;
  error?: unknown;
  streamOutcome: AgentOSAIStreamOutcome;
}): Readonly<Record<string, string | number>> {
  const safe = safeTelemetryAttributes(
    {
      ...input.base,
      ...outcomeAttributes(input.status, input.error),
      "agentos.ai.request.attempt_id": input.attemptId,
      "agentos.ai.stream.outcome": input.streamOutcome,
    },
    "log",
  );
  const spanContext = input.span.spanContext();
  return {
    event: "ai_gateway_failure",
    ...safe,
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  };
}

function logFailure(record: Readonly<Record<string, string | number>>) {
  console.error(JSON.stringify(record));
}

function elapsed(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt) / 1_000;
}

function boundedAdd(total: number, increment: number): number {
  const safeIncrement =
    Number.isFinite(increment) && increment > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, increment)
      : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, total + safeIncrement);
}

function boundedQuotaObservationAge(value: number): number {
  return Number.isFinite(value)
    ? Math.min(AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS, Math.max(0, value))
    : 0;
}

function safely(operation: () => void) {
  try {
    operation();
  } catch {
    // Telemetry is diagnostic-only and must not affect inference.
  }
}

const noopRequest: GatewayRequestTelemetry = Object.freeze({
  attemptId: "",
  authenticate() {},
  routeStarted() {},
  routeEnded() {},
  quotaObservation() {},
  upstreamStarted() {},
  upstreamHeaders() {},
  upstreamFailed() {},
  streamChunk() {},
  routeReleaseStarted() {},
  routeReleased() {},
  end() {},
});

const noopTelemetry: GatewayTelemetry = Object.freeze({
  enabled: false,
  startRequest() {
    return noopRequest;
  },
});
