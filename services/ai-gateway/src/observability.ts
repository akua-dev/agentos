import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";
import { Context, Effect } from "effect";

import type {
  GatewayRequestOutcome,
  GatewayRouteOutcome,
  GatewayTelemetry,
} from "./telemetry.ts";

export interface AIGatewayRequestTelemetry {
  readonly attemptId: string;
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

export function makeLegacyAIGatewayTelemetry(
  telemetry: GatewayTelemetry,
): AIGatewayTelemetry["Service"] {
  return AIGatewayTelemetry.of({
    enabled: telemetry.enabled,
    start: (request) => Effect.sync(() => telemetry.startRequest(request)).pipe(
      Effect.map(liftRequestTelemetry),
      Effect.catchCause(() => Effect.succeed(noopRequestTelemetry)),
    ),
  });
}

function liftRequestTelemetry(
  telemetry: ReturnType<GatewayTelemetry["startRequest"]>,
): AIGatewayRequestTelemetry {
  return {
    attemptId: telemetry.attemptId,
    authenticate: (authenticated, authorization, failureStatus) =>
      diagnosticEffect(() =>
        telemetry.authenticate(
          authenticated,
          authorization,
          failureStatus,
        )
      ),
    routeStarted: diagnosticEffect(() => telemetry.routeStarted()),
    routeEnded: (outcome, error) =>
      diagnosticEffect(() => telemetry.routeEnded(outcome, error)),
    quotaObservation: (ageSeconds, stale) =>
      diagnosticEffect(() => telemetry.quotaObservation(ageSeconds, stale)),
    upstreamStarted: (headers) =>
      diagnosticEffect(() => telemetry.upstreamStarted(headers)),
    upstreamHeaders: (status, headers) =>
      diagnosticEffect(() => telemetry.upstreamHeaders(status, headers)),
    upstreamFailed: (error) =>
      diagnosticEffect(() => telemetry.upstreamFailed(error)),
    streamChunk: (bytes) =>
      diagnosticEffect(() => telemetry.streamChunk(bytes)),
    routeReleaseStarted: diagnosticEffect(() =>
      telemetry.routeReleaseStarted()
    ),
    routeReleased: diagnosticEffect(() => telemetry.routeReleased()),
    routeReleaseFailed: diagnosticEffect(() =>
      telemetry.routeReleased(telemetryFailure)
    ),
    end: (outcome) => diagnosticEffect(() => telemetry.end(outcome)),
  };
}

function diagnosticEffect(operation: () => void): Effect.Effect<void> {
  return Effect.sync(operation).pipe(
    Effect.catchCause(() => Effect.void),
  );
}

const telemetryFailure = Object.freeze({
  _tag: "AIGatewayTelemetryFailure",
});

const noopRequestTelemetry: AIGatewayRequestTelemetry = Object.freeze({
  attemptId: "",
  authenticate: () => Effect.void,
  routeStarted: Effect.void,
  routeEnded: () => Effect.void,
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
