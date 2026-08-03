import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";
import {
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
  AGENTOS_AI_METRICS,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
  AGENTOS_TELEMETRY_EVENTS,
  AGENTOS_TELEMETRY_SPANS,
  classifyAIError,
  classifyAIStatus,
  safeEventAttributes,
  safeMetricAttributes,
  safeTelemetryAttributes,
  type AgentOSAIModelFamily,
  type AgentOSAIQuotaOutcome,
  type AgentOSAIRequestKind,
  type AgentOSAIRuntime,
  type AgentOSAISessionState,
  type AgentOSAIStreamMode,
  type AgentOSAIStreamOutcome,
  type AgentOSTelemetryAttributes,
} from "@akua-dev/agentos";
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Metric,
  SynchronizedRef,
  Tracer,
} from "effect";

export type GatewayRouteOutcome = "acquired" | "unavailable" | "error";

export interface GatewayRequestOutcome {
  readonly status?: number;
  readonly error?: unknown;
  readonly streamOutcome: AgentOSAIStreamOutcome;
}

export interface AIGatewayRequestTelemetry {
  readonly authenticate: (
    authenticated: boolean,
    authorization?: ProviderAuthorizationGrantV1,
    failureStatus?: 401 | 403,
  ) => Effect.Effect<void>;
  readonly routeStarted: Effect.Effect<void>;
  readonly routeEnded: (
    outcome: GatewayRouteOutcome,
    error?: unknown,
  ) => Effect.Effect<void>;
  readonly quotaRefresh: (
    outcome: AgentOSAIQuotaOutcome,
    error?: unknown,
  ) => Effect.Effect<void>;
  readonly quotaObservation: (
    ageSeconds: number,
    stale: boolean,
  ) => Effect.Effect<void>;
  readonly upstreamStarted: (headers: Headers) => Effect.Effect<void>;
  readonly upstreamHeaders: (
    status: number,
    headers: Headers,
  ) => Effect.Effect<void>;
  readonly upstreamFailed: (error: unknown) => Effect.Effect<void>;
  readonly streamChunk: (bytes: number) => Effect.Effect<void>;
  readonly routeReleaseStarted: Effect.Effect<void>;
  readonly routeReleased: Effect.Effect<void>;
  readonly routeReleaseFailed: Effect.Effect<void>;
  readonly end: (outcome: GatewayRequestOutcome) => Effect.Effect<void>;
}

export class AIGatewayTelemetry extends Context.Service<
  AIGatewayTelemetry,
  {
    readonly enabled: boolean;
    readonly start: (
      request: Request,
    ) => Effect.Effect<AIGatewayRequestTelemetry>;
  }
>()("agentos/ai-gateway/AIGatewayTelemetry") {}

export interface AIGatewayTelemetryOptions {
  readonly enabled?: boolean;
  readonly nextId?: Effect.Effect<string, unknown>;
}

interface TimedSpan {
  readonly span: Tracer.Span;
  readonly startedAt: bigint;
}

interface UpstreamState extends TimedSpan {
  readonly attemptId: string;
  readonly providerRequestId?: string;
  readonly status?: number;
}

interface StreamState extends TimedSpan {
  readonly active: boolean;
  readonly bytes: number;
  readonly chunks: number;
  readonly firstByteRecorded: boolean;
}

interface RequestState {
  readonly base: AgentOSTelemetryAttributes;
  readonly ended: boolean;
  readonly release?: TimedSpan;
  readonly requestSpan: Tracer.Span;
  readonly requestStartedAt: bigint;
  readonly reserved: boolean;
  readonly route?: TimedSpan;
  readonly stream?: StreamState;
  readonly tracestate?: string;
  readonly upstream?: UpstreamState;
}

const operationCounter = Metric.counter(AGENTOS_AI_METRICS.operations, {
  description: "Completed AgentOS AI Gateway operations",
  incremental: true,
});
const providerAttemptCounter = Metric.counter(
  AGENTOS_AI_METRICS.providerAttempts,
  { description: "Completed AI provider attempts", incremental: true },
);
const operationDuration = Metric.histogram(
  AGENTOS_AI_METRICS.operationDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const providerDuration = Metric.histogram(
  AGENTOS_AI_METRICS.providerDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const upstreamHeadersDuration = Metric.histogram(
  AGENTOS_AI_METRICS.upstreamHeadersDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const firstByteDuration = Metric.histogram(
  AGENTOS_AI_METRICS.firstByteDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const streamDuration = Metric.histogram(AGENTOS_AI_METRICS.streamDuration, {
  boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS,
});
const activeStreams = Metric.counter(AGENTOS_AI_METRICS.activeStreams, {
  description: "Currently active AI Gateway streams",
});
const streamChunks = Metric.counter(AGENTOS_AI_METRICS.streamChunks, {
  incremental: true,
});
const streamBytes = Metric.counter(AGENTOS_AI_METRICS.streamBytes, {
  incremental: true,
});
const streams = Metric.counter(AGENTOS_AI_METRICS.streams, {
  incremental: true,
});
const routeAcquisitionDuration = Metric.histogram(
  AGENTOS_AI_METRICS.routeAcquisitionDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const routeEvents = Metric.counter(AGENTOS_AI_METRICS.routeEvents, {
  incremental: true,
});
const activeReservations = Metric.counter(
  AGENTOS_AI_METRICS.activeReservations,
  { description: "Currently active AI Gateway route reservations" },
);
const quotaObservationAge = Metric.histogram(
  AGENTOS_AI_METRICS.quotaObservationAge,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const quotaRefreshes = Metric.counter(AGENTOS_AI_METRICS.quotaRefreshes, {
  incremental: true,
});

export const makeAIGatewayTelemetry = Effect.fn(
  "agentos.aiGateway.makeTelemetry",
)(function*(options: AIGatewayTelemetryOptions = {}) {
  if (options.enabled === false) return noopAIGatewayTelemetry;
  const crypto = yield* Crypto.Crypto;
  const nextId = options.nextId ?? crypto.randomUUIDv4;

  const startRequest = (request: Request) =>
    Effect.gen(function*() {
      const operationId = yield* nextId;
      const base = requestAttributes(request.headers, operationId);
      const parent = traceParent(request.headers);
      const requestStartedAt = yield* Clock.currentTimeNanos;
      const requestSpan = yield* Effect.makeSpan(
        AGENTOS_TELEMETRY_SPANS.aiGatewayRequest,
        {
          kind: "server",
          attributes: base,
          ...(parent === undefined ? {} : { parent }),
        },
      );
      const state = yield* SynchronizedRef.make<RequestState>({
        base,
        ended: false,
        requestSpan,
        requestStartedAt,
        reserved: false,
        ...(safeTraceState(request.headers) === undefined
          ? {}
          : { tracestate: safeTraceState(request.headers) }),
      });
      return requestTelemetry(state, nextId);
    });

  return AIGatewayTelemetry.of({
    enabled: true,
    start: (request) =>
      startRequest(request).pipe(
        Effect.catchCause(() => Effect.succeed(noopRequestTelemetry)),
      ),
  });
});

function stateTransition<A>(
  result: A,
  state: RequestState,
): readonly [A, RequestState] {
  return [result, state];
}

function requestTelemetry(
  state: SynchronizedRef.SynchronizedRef<RequestState>,
  nextId: Effect.Effect<string, unknown>,
): AIGatewayRequestTelemetry {
  const modify = <A, E>(
    transition: (
      current: RequestState,
    ) => Effect.Effect<readonly [A, RequestState], E>,
    fallback: A,
  ): Effect.Effect<A> =>
    SynchronizedRef.modifyEffect(state, transition).pipe(
      Effect.catchCause(() => Effect.succeed(fallback)),
    );

  const startStream = (current: RequestState) =>
    current.stream !== undefined || current.ended
      ? Effect.succeed(current)
      : Effect.gen(function*() {
          const startedAt = yield* Clock.currentTimeNanos;
          const span = yield* Effect.makeSpan(
            AGENTOS_TELEMETRY_SPANS.aiGatewayStream,
            {
              attributes: current.base,
              kind: "internal",
              parent: current.upstream?.span ?? current.requestSpan,
            },
          );
          yield* updateCounter(
            activeStreams,
            AGENTOS_AI_METRICS.activeStreams,
            1,
            current.base,
          );
          return {
            ...current,
            stream: {
              active: true,
              bytes: 0,
              chunks: 0,
              firstByteRecorded: false,
              span,
              startedAt,
            },
          } satisfies RequestState;
        });

  return {
    authenticate: (authenticated, authorization, failureStatus) =>
      modify(
        (current) => {
          if (current.ended) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          const attribution = authorization === undefined
            ? {}
            : authorizationAttributes(authorization);
          const next = authenticated && authorization !== undefined
            ? { ...current, base: { ...current.base, ...attribution } }
            : current;
          return Effect.gen(function*() {
            yield* setSpanAttributes(current.requestSpan, attribution);
            const span = yield* Effect.makeSpan(
              AGENTOS_TELEMETRY_SPANS.aiGatewayAuthenticate,
              { kind: "internal", parent: current.requestSpan },
            );
            yield* endSpan(
              span,
              {
                ...attribution,
                ...outcomeAttributes(
                  authenticated ? 200 : (failureStatus ?? 401),
                ),
              },
            );
            return stateTransition(undefined, next);
          });
        },
        undefined,
      ),
    routeStarted: modify(
      (current) => {
        if (current.ended || current.route !== undefined) {
          return Effect.succeed(stateTransition(undefined, current));
        }
        return Effect.gen(function*() {
          const startedAt = yield* Clock.currentTimeNanos;
          const span = yield* Effect.makeSpan(
            AGENTOS_TELEMETRY_SPANS.aiGatewayRouteAcquire,
            { kind: "internal", parent: current.requestSpan },
          );
          return stateTransition(undefined, {
            ...current,
            route: { span, startedAt },
          });
        });
      },
      undefined,
    ),
    routeEnded: (outcome, error) =>
      Effect.gen(function*() {
        const claimed = yield* SynchronizedRef.modify(
          state,
          (current): readonly [RequestState | undefined, RequestState] => {
            if (current.ended || current.route === undefined) {
              return stateTransition(undefined, current);
            }
            return stateTransition(current, {
              ...current,
              reserved: current.reserved || outcome === "acquired",
              route: undefined,
            });
          },
        );
        if (claimed === undefined) return;
        const route = claimed.route;
        if (route === undefined) return;
        const status = outcome === "acquired" ? 200 : 503;
        const final = {
          ...outcomeAttributes(status, error),
          "agentos.ai.route.operation": "acquire",
        };
        yield* diagnostics([
          endSpan(route.span, final),
          observeHistogram(
            routeAcquisitionDuration,
            AGENTOS_AI_METRICS.routeAcquisitionDuration,
            elapsedSeconds(route.startedAt, yield* Clock.currentTimeNanos),
            { ...claimed.base, ...final },
          ),
          updateCounter(
            routeEvents,
            AGENTOS_AI_METRICS.routeEvents,
            1,
            { ...claimed.base, ...final },
          ),
          ...(outcome === "acquired"
            ? [
                updateCounter(
                  routeEvents,
                  AGENTOS_AI_METRICS.routeEvents,
                  1,
                  {
                    ...claimed.base,
                    ...outcomeAttributes(200),
                    "agentos.ai.route.operation": "reserve",
                  },
                ),
                updateCounter(
                  activeReservations,
                  AGENTOS_AI_METRICS.activeReservations,
                  1,
                  claimed.base,
                ),
              ]
            : outcome === "unavailable"
            ? [
                updateCounter(
                  routeEvents,
                  AGENTOS_AI_METRICS.routeEvents,
                  1,
                  {
                    ...claimed.base,
                    ...outcomeAttributes(503, error),
                    "agentos.ai.route.operation": "block",
                  },
                ),
              ]
            : []),
        ]);
      }).pipe(Effect.catchCause(() => Effect.void)),
    quotaRefresh: (outcome, error) =>
      modify(
        (current) => {
          if (current.ended) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          const final = {
            "agentos.ai.quota.outcome": outcome,
            ...outcomeAttributes(
              outcome === "failed" ? 503 : 200,
              error,
            ),
          };
          return Effect.gen(function*() {
            const span = yield* Effect.makeSpan(
              AGENTOS_TELEMETRY_SPANS.aiGatewayQuotaRefresh,
              { kind: "client", parent: current.requestSpan },
            );
            yield* diagnostics([
              endSpan(span, final),
              updateCounter(
                quotaRefreshes,
                AGENTOS_AI_METRICS.quotaRefreshes,
                1,
                { ...current.base, ...final },
              ),
            ]);
            return stateTransition(undefined, current);
          });
        },
        undefined,
      ),
    quotaObservation: (ageSeconds, stale) =>
      SynchronizedRef.get(state).pipe(
        Effect.flatMap((current) =>
          current.ended
            ? Effect.void
            : observeHistogram(
                quotaObservationAge,
                AGENTOS_AI_METRICS.quotaObservationAge,
                boundedQuotaObservationAge(ageSeconds),
                {
                  ...current.base,
                  "agentos.ai.quota.stale": stale,
                },
              )
        ),
        Effect.catchCause(() => Effect.void),
      ),
    upstreamStarted: (headers) =>
      modify(
        (current) => {
          if (current.ended || current.upstream !== undefined) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          return Effect.gen(function*() {
            const attemptId = yield* nextId;
            const startedAt = yield* Clock.currentTimeNanos;
            const span = yield* Effect.makeSpan(
              AGENTOS_TELEMETRY_SPANS.aiGatewayUpstream,
              {
                attributes: safeTelemetryAttributes({
                  ...current.base,
                  "agentos.ai.request.attempt_id": attemptId,
                }, "span"),
                kind: "client",
                parent: current.requestSpan,
              },
            );
            yield* Effect.sync(() => {
              headers.set(
                "traceparent",
                `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`,
              );
              if (current.tracestate !== undefined) {
                headers.set("tracestate", current.tracestate);
              }
              headers.set("x-client-request-id", attemptId);
            }).pipe(Effect.catchCause(() => Effect.void));
            return stateTransition(undefined, {
              ...current,
              upstream: { attemptId, span, startedAt },
            });
          });
        },
        undefined,
      ),
    upstreamHeaders: (status, headers) =>
      modify(
        (current) => {
          if (current.ended || current.upstream === undefined) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          const upstream = current.upstream;
          const providerRequestId = safeProviderRequestId(headers);
          return Effect.gen(function*() {
            const withUpstream = {
              ...current,
              upstream: {
                ...upstream,
                status,
                ...(providerRequestId === undefined
                  ? {}
                  : { providerRequestId }),
              },
            } satisfies RequestState;
            yield* setSpanAttributes(
              upstream.span,
              safeTelemetryAttributes({
                ...outcomeAttributes(status),
                ...(providerRequestId === undefined
                  ? {}
                  : {
                      "agentos.ai.provider.request_id": providerRequestId,
                    }),
              }, "span"),
            );
            const endedAt = yield* Clock.currentTimeNanos;
            yield* observeHistogram(
              upstreamHeadersDuration,
              AGENTOS_AI_METRICS.upstreamHeadersDuration,
              elapsedSeconds(upstream.startedAt, endedAt),
              { ...current.base, ...outcomeAttributes(status) },
            );
            const withStream = yield* startStream(withUpstream);
            return stateTransition(undefined, withStream);
          });
        },
        undefined,
      ),
    upstreamFailed: (error) =>
      modify(
        (current) => {
          if (current.ended || current.upstream === undefined) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          return setSpanAttributes(
            current.upstream.span,
            outcomeAttributes(undefined, error),
          ).pipe(Effect.as(stateTransition(undefined, current)));
        },
        undefined,
      ),
    streamChunk: (size) =>
      modify(
        (current) => {
          if (current.ended) {
            return Effect.succeed(stateTransition(undefined, current));
          }
          return Effect.gen(function*() {
            const streaming = yield* startStream(current);
            const stream = streaming.stream;
            if (stream === undefined) {
              return stateTransition(undefined, streaming);
            }
            const safeSize = boundedAdd(0, size);
            if (!stream.firstByteRecorded && streaming.upstream !== undefined) {
              const endedAt = yield* Clock.currentTimeNanos;
              yield* observeHistogram(
                firstByteDuration,
                AGENTOS_AI_METRICS.firstByteDuration,
                elapsedSeconds(streaming.upstream.startedAt, endedAt),
                streaming.base,
              );
            }
            return stateTransition(undefined, {
              ...streaming,
              stream: {
                ...stream,
                bytes: boundedAdd(stream.bytes, safeSize),
                chunks: boundedAdd(stream.chunks, 1),
                firstByteRecorded: true,
              },
            });
          });
        },
        undefined,
      ),
    routeReleaseStarted: modify(
      (current) => {
        if (current.ended || current.release !== undefined) {
          return Effect.succeed(stateTransition(undefined, current));
        }
        return Effect.gen(function*() {
          const startedAt = yield* Clock.currentTimeNanos;
          const span = yield* Effect.makeSpan(
            AGENTOS_TELEMETRY_SPANS.aiGatewayRouteRelease,
            { kind: "internal", parent: current.requestSpan },
          );
          return stateTransition(undefined, {
            ...current,
            release: { span, startedAt },
          });
        });
      },
      undefined,
    ),
    routeReleased: finishRelease(state, undefined),
    routeReleaseFailed: finishRelease(state, routeReleaseFailure),
    end: (outcome) => finishRequest(state, outcome),
  };
}

function finishRelease(
  state: SynchronizedRef.SynchronizedRef<RequestState>,
  error: unknown,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const claimed = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RequestState | undefined, RequestState] => {
        if (current.ended || current.release === undefined) {
          return stateTransition(undefined, current);
        }
        return stateTransition(current, {
          ...current,
          release: undefined,
          reserved: false,
        });
      },
    );
    if (claimed === undefined) return;
    const release = claimed.release;
    if (release === undefined) return;
    const final = {
      ...outcomeAttributes(error === undefined ? 200 : 500, error),
      "agentos.ai.route.operation": "release",
    };
    yield* diagnostics([
      endSpan(release.span, final),
      updateCounter(
        routeEvents,
        AGENTOS_AI_METRICS.routeEvents,
        1,
        { ...claimed.base, ...final },
      ),
      ...(claimed.reserved
        ? [
            updateCounter(
              activeReservations,
              AGENTOS_AI_METRICS.activeReservations,
              -1,
              claimed.base,
            ),
          ]
        : []),
    ]);
  }).pipe(Effect.catchCause(() => Effect.void));
}

function finishRequest(
  state: SynchronizedRef.SynchronizedRef<RequestState>,
  outcome: GatewayRequestOutcome,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const claimed = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RequestState | undefined, RequestState] =>
        current.ended
          ? stateTransition(undefined, current)
          : stateTransition(current, {
              ...current,
              ended: true,
              release: undefined,
              reserved: false,
              route: undefined,
              stream: current.stream === undefined
                ? undefined
                : { ...current.stream, active: false },
            }),
    );
    if (claimed === undefined) return;
    const endedAt = yield* Clock.currentTimeNanos;
    const final = {
      ...outcomeAttributes(outcome.status, outcome.error),
      "agentos.ai.stream.outcome": outcome.streamOutcome,
    };
    const operations: Array<Effect.Effect<void>> = [];
    if (claimed.route !== undefined) {
      operations.push(endSpan(
        claimed.route.span,
        {
          ...outcomeAttributes(503, outcome.error),
          "agentos.ai.route.operation": "acquire",
        },
      ));
    }
    if (claimed.release !== undefined) {
      operations.push(endSpan(
        claimed.release.span,
        {
          ...outcomeAttributes(500, outcome.error ?? routeReleaseFailure),
          "agentos.ai.route.operation": "release",
        },
      ));
    }
    if (claimed.reserved) {
      operations.push(updateCounter(
        activeReservations,
        AGENTOS_AI_METRICS.activeReservations,
        -1,
        claimed.base,
      ));
    }
    if (claimed.stream !== undefined) {
      const streamFinal = safeTelemetryAttributes({
        ...final,
        "agentos.ai.stream.bytes": claimed.stream.bytes,
        "agentos.ai.stream.chunks": claimed.stream.chunks,
      }, "span");
      operations.push(
        endSpan(claimed.stream.span, streamFinal),
        observeHistogram(
          streamDuration,
          AGENTOS_AI_METRICS.streamDuration,
          elapsedSeconds(claimed.stream.startedAt, endedAt),
          { ...claimed.base, ...final },
        ),
        updateCounter(
          streamChunks,
          AGENTOS_AI_METRICS.streamChunks,
          claimed.stream.chunks,
          { ...claimed.base, ...final },
        ),
        updateCounter(
          streamBytes,
          AGENTOS_AI_METRICS.streamBytes,
          claimed.stream.bytes,
          { ...claimed.base, ...final },
        ),
        updateCounter(
          streams,
          AGENTOS_AI_METRICS.streams,
          1,
          { ...claimed.base, ...final },
        ),
      );
      if (claimed.stream.active) {
        operations.push(updateCounter(
          activeStreams,
          AGENTOS_AI_METRICS.activeStreams,
          -1,
          claimed.base,
        ));
      }
    }
    if (claimed.upstream !== undefined) {
      operations.push(
        endSpan(claimed.upstream.span, safeTelemetryAttributes({
          ...final,
          "agentos.ai.request.attempt_id": claimed.upstream.attemptId,
          ...(claimed.upstream.providerRequestId === undefined
            ? {}
            : {
                "agentos.ai.provider.request_id":
                  claimed.upstream.providerRequestId,
              }),
        }, "span")),
        updateCounter(
          providerAttemptCounter,
          AGENTOS_AI_METRICS.providerAttempts,
          1,
          { ...claimed.base, ...final },
        ),
        observeHistogram(
          providerDuration,
          AGENTOS_AI_METRICS.providerDuration,
          elapsedSeconds(claimed.upstream.startedAt, endedAt),
          { ...claimed.base, ...final },
        ),
      );
    }
    operations.push(
      updateCounter(
        operationCounter,
        AGENTOS_AI_METRICS.operations,
        1,
        { ...claimed.base, ...final },
      ),
      observeHistogram(
        operationDuration,
        AGENTOS_AI_METRICS.operationDuration,
        elapsedSeconds(claimed.requestStartedAt, endedAt),
        { ...claimed.base, ...final },
      ),
    );
    if (
      outcome.error !== undefined ||
      classifyAIStatus(outcome.status, outcome.error) !== "success"
    ) {
      operations.push(failureLog(claimed, final));
    }
    operations.push(endSpan(claimed.requestSpan, final));
    yield* diagnostics(operations);
  }).pipe(Effect.catchCause(() => Effect.void));
}

function failureLog(
  state: RequestState,
  final: AgentOSTelemetryAttributes,
): Effect.Effect<void> {
  const safe = safeEventAttributes(
    AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
    {
      ...state.base,
      ...final,
      ...(state.upstream === undefined
        ? {}
        : {
            "agentos.ai.request.attempt_id": state.upstream.attemptId,
            ...(state.upstream.providerRequestId === undefined
              ? {}
              : {
                  "agentos.ai.provider.request_id":
                    state.upstream.providerRequestId,
                }),
          }),
    },
  );
  const span = state.upstream?.span ?? state.requestSpan;
  return Effect.logWarning(AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure).pipe(
    Effect.annotateLogs({
      ...safe,
      event: AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
      span_id: span.spanId,
      trace_id: span.traceId,
    }),
    Effect.withParentSpan(span),
  );
}

function diagnostics(
  effects: ReadonlyArray<Effect.Effect<void>>,
): Effect.Effect<void> {
  return Effect.forEach(
    effects,
    (effect) => effect.pipe(Effect.catchCause(() => Effect.void)),
    { discard: true },
  );
}

function endSpan(
  span: Tracer.Span,
  attributes: Readonly<Record<string, unknown>>,
): Effect.Effect<void> {
  const safe = safeTelemetryAttributes(attributes, "span");
  return Effect.gen(function*() {
    yield* setSpanAttributes(span, safe);
    const endedAt = yield* Clock.currentTimeNanos;
    yield* Effect.sync(() =>
      span.end(
        endedAt,
        safe["agentos.ai.status_class"] === "success"
          ? Exit.succeed(undefined)
          : Exit.fail(String(safe["agentos.ai.error.class"] ?? "unknown")),
      )
    );
  });
}

function setSpanAttributes(
  span: Tracer.Span,
  attributes: Readonly<Record<string, unknown>>,
): Effect.Effect<void> {
  const safe = safeTelemetryAttributes(attributes, "span");
  return Effect.sync(() => {
    for (const [key, value] of Object.entries(safe)) {
      span.attribute(key, value);
    }
  });
}

function updateCounter(
  metric: Metric.Counter<number>,
  name: string,
  value: number,
  attributes: Readonly<Record<string, unknown>>,
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(metric, metricAttributes(name, attributes)),
    value,
  );
}

function observeHistogram(
  metric: Metric.Histogram<number>,
  name: string,
  value: number,
  attributes: Readonly<Record<string, unknown>>,
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(metric, metricAttributes(name, attributes)),
    value,
  );
}

function metricAttributes(
  name: string,
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(safeMetricAttributes(name, attributes)).map(
      ([key, value]) => [key, String(value)],
    ),
  );
}

function requestAttributes(
  headers: Headers,
  operationId: string,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
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
    "agentos.ai.operation.id": operationId,
  }, "span");
}

function authorizationAttributes(
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

function outcomeAttributes(
  status?: number,
  error?: unknown,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
    "agentos.ai.status_class": classifyAIStatus(status, error),
    "agentos.ai.error.class": classifyAIError(error, status),
    ...(status === undefined ? {} : { "http.response.status_code": status }),
  }, "span");
}

function traceParent(headers: Headers): Tracer.ExternalSpan | undefined {
  const value = headers.get("traceparent")?.trim().toLowerCase();
  const match = value?.match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/,
  );
  if (
    match === null || match === undefined ||
    match[1] === "00000000000000000000000000000000" ||
    match[2] === "0000000000000000"
  ) {
    return undefined;
  }
  const traceId = match[1];
  const spanId = match[2];
  const flags = match[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return undefined;
  }
  return Tracer.externalSpan({
    traceId,
    spanId,
    sampled: flags === "01",
  });
}

function safeTraceState(headers: Headers): string | undefined {
  const value = headers.get("tracestate")?.trim();
  if (value === undefined || value.length === 0 || value.length > 512) {
    return undefined;
  }
  const members = value.split(",");
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  for (const rawMember of members) {
    const member = rawMember.trim();
    if (member.length === 0) continue;
    const separator = member.indexOf("=");
    if (separator <= 0 || separator !== member.lastIndexOf("=")) {
      return undefined;
    }
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (
      !isTraceStateKey(key) || keys.has(key) || memberValue.length === 0 ||
      memberValue.length > 256 ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(
        memberValue,
      )
    ) {
      return undefined;
    }
    keys.add(key);
  }
  return keys.size === 0 ? undefined : value;
}

function isTraceStateKey(value: string): boolean {
  return /^[a-z][a-z0-9_*/-]{0,255}$/.test(value) ||
    /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/.test(
      value,
    );
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

function boundedHeader<T extends string>(
  headers: Headers,
  name: string,
  values: ReadonlyArray<T>,
  fallback: T,
): T {
  const value = headers.get(name)?.trim();
  return values.find((candidate) => candidate === value) ?? fallback;
}

function inferRuntime(headers: Headers): AgentOSAIRuntime {
  return /\bcodex\b/i.test(headers.get("user-agent") ?? "") ? "codex" : "pi";
}

function elapsedSeconds(startedAt: bigint, endedAt: bigint): number {
  return Math.max(0, Number(endedAt - startedAt) / 1_000_000_000);
}

function boundedAdd(total: number, increment: number): number {
  const safeIncrement = Number.isFinite(increment) && increment > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, increment)
    : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, total + safeIncrement);
}

function boundedQuotaObservationAge(value: number): number {
  return Number.isFinite(value)
    ? Math.min(AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS, Math.max(0, value))
    : 0;
}

const routeReleaseFailure = Object.freeze({
  code: "state_unavailable",
  name: "RouteReleaseFailure",
});

const noopRequestTelemetry: AIGatewayRequestTelemetry = Object.freeze({
  authenticate: () => Effect.void,
  routeStarted: Effect.void,
  routeEnded: () => Effect.void,
  quotaRefresh: () => Effect.void,
  quotaObservation: () => Effect.void,
  upstreamStarted: () => Effect.void,
  upstreamHeaders: () => Effect.void,
  upstreamFailed: () => Effect.void,
  streamChunk: () => Effect.void,
  routeReleaseStarted: Effect.void,
  routeReleased: Effect.void,
  routeReleaseFailed: Effect.void,
  end: () => Effect.void,
});

export const noopAIGatewayTelemetry = AIGatewayTelemetry.of({
  enabled: false,
  start: () => Effect.succeed(noopRequestTelemetry),
});
