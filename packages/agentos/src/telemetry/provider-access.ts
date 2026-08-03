import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  SynchronizedRef,
  Tracer,
} from "effect";

import type { ProviderAuthorizationGrantV1 } from "../access/http-authorizer.ts";
import {
  AGENTOS_ACCESS_METRICS,
  AGENTOS_AI_DURATION_BUCKETS_SECONDS,
  AGENTOS_TELEMETRY_CONTRACT_VERSION,
  AGENTOS_TELEMETRY_SPANS,
  type AgentOSAccessAdapter,
  type AgentOSAccessCredentialOutcome,
  type AgentOSAccessDecision,
  type AgentOSAccessDependency,
  type AgentOSAccessOperation,
  type AgentOSAccessProvider,
  type AgentOSAccessProviderOutcome,
  type AgentOSAccessReason,
  type AgentOSAccessRoute,
} from "./contract.ts";
import {
  safeMetricAttributes,
  safeTelemetryAttributes,
  type AgentOSTelemetryAttributes,
} from "./privacy.ts";

export interface ProviderAccessTelemetryStart {
  readonly request: Request;
  readonly operation: AgentOSAccessOperation;
  readonly route: AgentOSAccessRoute;
  readonly adapter: AgentOSAccessAdapter;
  readonly provider: AgentOSAccessProvider;
}

export interface ProviderAccessTelemetryEnd {
  readonly decision: AgentOSAccessDecision;
  readonly reason: AgentOSAccessReason;
  readonly dependency: AgentOSAccessDependency;
  readonly providerOutcome: AgentOSAccessProviderOutcome;
  readonly status?: number;
}

export interface ProviderAccessTelemetryOperation {
  readonly correlate: (
    grant: ProviderAuthorizationGrantV1,
  ) => Effect.Effect<void>;
  readonly credential: (
    outcome: AgentOSAccessCredentialOutcome,
  ) => Effect.Effect<void>;
  readonly end: (outcome: ProviderAccessTelemetryEnd) => Effect.Effect<void>;
}

export class ProviderAccessTelemetry extends Context.Service<
  ProviderAccessTelemetry,
  {
    readonly start: (
      input: ProviderAccessTelemetryStart,
    ) => Effect.Effect<ProviderAccessTelemetryOperation>;
  }
>()("agentos/telemetry/ProviderAccessTelemetry") {}

interface ProviderAccessTelemetryState {
  readonly base: AgentOSTelemetryAttributes;
  readonly correlated: AgentOSTelemetryAttributes;
  readonly credentialOutcome: AgentOSAccessCredentialOutcome;
  readonly ended: boolean;
  readonly span: Tracer.Span;
  readonly startedAt: bigint;
}

const decisionCounter = Metric.counter(AGENTOS_ACCESS_METRICS.decisions, {
  description: "Completed AgentOS provider-access decisions",
  incremental: true,
});
const decisionDuration = Metric.histogram(
  AGENTOS_ACCESS_METRICS.decisionDuration,
  { boundaries: AGENTOS_AI_DURATION_BUCKETS_SECONDS },
);
const credentialReleaseCounter = Metric.counter(
  AGENTOS_ACCESS_METRICS.credentialReleases,
  {
    description: "Provider credential release outcomes",
    incremental: true,
  },
);
const providerOperationCounter = Metric.counter(
  AGENTOS_ACCESS_METRICS.providerOperations,
  {
    description: "Provider adapter terminal outcomes",
    incremental: true,
  },
);

export const noopProviderAccessTelemetryOperation:
  ProviderAccessTelemetryOperation = Object.freeze({
    correlate: () => Effect.void,
    credential: () => Effect.void,
    end: () => Effect.void,
  });

export const noopProviderAccessTelemetry = ProviderAccessTelemetry.of({
  start: () => Effect.succeed(noopProviderAccessTelemetryOperation),
});

export const makeProviderAccessTelemetry = Effect.fn(
  "agentos.telemetry.makeProviderAccess",
)(function*() {
  const start = (input: ProviderAccessTelemetryStart) =>
    Effect.gen(function*() {
      const base = safeTelemetryAttributes({
        "agentos.telemetry.contract.version":
          AGENTOS_TELEMETRY_CONTRACT_VERSION,
        "agentos.access.operation": input.operation,
        "agentos.access.route": input.route,
        "agentos.access.adapter": input.adapter,
        "agentos.access.provider": input.provider,
      }, "span");
      const parent = traceParent(input.request.headers);
      const startedAt = yield* Clock.currentTimeNanos;
      const span = yield* Effect.makeSpan(spanName(input), {
        attributes: base,
        kind: "server",
        ...(parent === undefined ? {} : { parent }),
      });
      const state = yield* SynchronizedRef.make<ProviderAccessTelemetryState>({
        base,
        correlated: {},
        credentialOutcome: "not_requested",
        ended: false,
        span,
        startedAt,
      });
      return makeOperation(state);
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(noopProviderAccessTelemetryOperation)
      ),
    );

  return ProviderAccessTelemetry.of({ start });
});

export const ProviderAccessTelemetryLiveLayer = Layer.effect(
  ProviderAccessTelemetry,
  makeProviderAccessTelemetry(),
);

export const ProviderAccessTelemetryNoopLayer = Layer.succeed(
  ProviderAccessTelemetry,
  noopProviderAccessTelemetry,
);

function makeOperation(
  state: SynchronizedRef.SynchronizedRef<ProviderAccessTelemetryState>,
): ProviderAccessTelemetryOperation {
  const correlate = (grant: ProviderAuthorizationGrantV1) =>
    SynchronizedRef.modifyEffect(state, (current) => {
      if (current.ended) {
        return Effect.succeed(stateTransition(undefined, current));
      }
      const correlated = authorizationAttributes(grant);
      return setSpanAttributes(current.span, correlated).pipe(
        Effect.as(stateTransition(undefined, { ...current, correlated })),
      );
    }).pipe(Effect.catchCause(() => Effect.void));

  const credential = (outcome: AgentOSAccessCredentialOutcome) =>
    SynchronizedRef.update(state, (current) =>
      current.ended || current.credentialOutcome !== "not_requested"
        ? current
        : { ...current, credentialOutcome: outcome }
    ).pipe(Effect.catchCause(() => Effect.void));

  const end = (outcome: ProviderAccessTelemetryEnd) =>
    SynchronizedRef.modify(state, (current) =>
      current.ended
        ? stateTransition(
            Option.none<ProviderAccessTelemetryState>(),
            current,
          )
        : stateTransition(Option.some(current), { ...current, ended: true })
    ).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.void,
        onSome: (claimed) => finishOperation(claimed, outcome),
      })),
      Effect.catchCause(() => Effect.void),
    );

  return { correlate, credential, end };
}

function stateTransition<A>(
  result: A,
  state: ProviderAccessTelemetryState,
): readonly [A, ProviderAccessTelemetryState] {
  return [result, state];
}

function finishOperation(
  state: ProviderAccessTelemetryState,
  outcome: ProviderAccessTelemetryEnd,
) {
  return Effect.gen(function*() {
    const endedAt = yield* Clock.currentTimeNanos;
    const final = safeTelemetryAttributes({
      ...state.base,
      ...state.correlated,
      "agentos.access.decision": outcome.decision,
      "agentos.access.reason": outcome.reason,
      "agentos.access.dependency": outcome.dependency,
      "agentos.access.credential.outcome": state.credentialOutcome,
      "agentos.access.provider.outcome": outcome.providerOutcome,
      ...(outcome.status === undefined
        ? {}
        : { "http.response.status_code": outcome.status }),
    }, "span");
    const metricInput = {
      ...state.base,
      ...final,
    };
    const diagnostics: Array<Effect.Effect<void>> = [
      updateCounter(
        decisionCounter,
        AGENTOS_ACCESS_METRICS.decisions,
        metricInput,
      ),
      observeHistogram(
        decisionDuration,
        AGENTOS_ACCESS_METRICS.decisionDuration,
        elapsedSeconds(state.startedAt, endedAt),
        metricInput,
      ),
    ];
    if (state.credentialOutcome !== "not_requested") {
      diagnostics.push(updateCounter(
        credentialReleaseCounter,
        AGENTOS_ACCESS_METRICS.credentialReleases,
        metricInput,
      ));
    }
    if (outcome.providerOutcome !== "unobserved") {
      diagnostics.push(updateCounter(
        providerOperationCounter,
        AGENTOS_ACCESS_METRICS.providerOperations,
        metricInput,
      ));
    }
    diagnostics.push(endSpan(state.span, final, endedAt, outcome));
    yield* Effect.forEach(
      diagnostics,
      (diagnostic) => diagnostic.pipe(Effect.catchCause(() => Effect.void)),
      { discard: true },
    );
  }).pipe(Effect.catchCause(() => Effect.void));
}

function authorizationAttributes(
  grant: ProviderAuthorizationGrantV1,
): AgentOSTelemetryAttributes {
  return safeTelemetryAttributes({
    "agentos.identity.agent_id": grant.identity.agentId,
    ...(grant.identity.assignmentId === null
      ? {}
      : { "agentos.identity.assignment_id": grant.identity.assignmentId }),
    "agentos.authz.decision_ref": grant.decisionRef,
    "agentos.authz.profile_id": grant.profile.profileId,
    "agentos.authz.profile_version": grant.profile.profileVersion,
    "agentos.authz.rate_class": grant.rateClass,
  }, "span");
}

function spanName(input: ProviderAccessTelemetryStart): string {
  if (input.adapter === "egress_authz") {
    return AGENTOS_TELEMETRY_SPANS.accessAuthorization;
  }
  if (input.adapter === "github_broker" || input.adapter === "ai_gateway") {
    return AGENTOS_TELEMETRY_SPANS.accessProviderAdapter;
  }
  return AGENTOS_TELEMETRY_SPANS.accessAgentGateway;
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

function endSpan(
  span: Tracer.Span,
  attributes: Readonly<Record<string, unknown>>,
  endedAt: bigint,
  outcome: ProviderAccessTelemetryEnd,
): Effect.Effect<void> {
  return setSpanAttributes(span, attributes).pipe(
    Effect.andThen(Effect.sync(() =>
      span.end(
        endedAt,
        outcome.decision === "allow"
          ? Exit.succeed(undefined)
          : Exit.fail(outcome.reason),
      )
    )),
  );
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
  attributes: Readonly<Record<string, unknown>>,
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(metric, metricAttributes(name, attributes)),
    1,
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

function elapsedSeconds(startedAt: bigint, endedAt: bigint): number {
  return Number(endedAt - startedAt) / 1_000_000_000;
}
