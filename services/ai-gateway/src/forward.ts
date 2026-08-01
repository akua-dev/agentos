import { createHash, timingSafeEqual } from "node:crypto";
import {
  extractSessionKey,
  isSupportedResponsePath,
  resolveUpstreamTarget,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from "@akua-dev/codex-router/codex";
import {
  decodeProviderAuthorizationGrantHeaders,
  type ProviderAuthorizationError,
  type ProviderAuthorizationGrantV1,
  type ProviderBudgetSettlementReporter,
  type ProviderBudgetSettlementReportV1,
} from "@akua-dev/agentos";
import {
  Cause,
  Effect,
  Exit,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";

import {
  AIGatewayTelemetry,
  type AIGatewayRequestTelemetry,
} from "./observability.ts";
import {
  type AIProviderHttp,
  type AIProviderHttpError,
} from "./provider-http.ts";
import {
  makeOpenAITerminalUsageObserver,
  type OpenAITerminalUsageObserver,
} from "./response-usage.ts";

const AIForwardConfigurationErrorCode = Schema.Literals([
  "invalid_configuration",
]);

export class AIForwardConfigurationError extends Schema.TaggedErrorClass<AIForwardConfigurationError>()(
  "AIForwardConfigurationError",
  { code: AIForwardConfigurationErrorCode },
) {}

const AIForwardRouteErrorCode = Schema.Literals([
  "credential_unavailable",
  "routing_unavailable",
  "state_unavailable",
]);

export class AIForwardRouteError extends Schema.TaggedErrorClass<AIForwardRouteError>()(
  "AIForwardRouteError",
  { code: AIForwardRouteErrorCode },
) {}

export interface AIForwardLease {
  readonly kind: "codex_oauth" | "openai_api_key";
  readonly accessToken: string;
  readonly providerAccountId?: string;
  readonly renew: Effect.Effect<boolean, AIForwardRouteError>;
  readonly release: Effect.Effect<void, AIForwardRouteError>;
  readonly recordResponse?: (
    status: number,
    headers: Headers,
  ) => Effect.Effect<void, AIForwardRouteError>;
}

export type AIForwardClientAuthentication =
  | {
      readonly kind: "shared_token";
      readonly token: string;
    }
  | {
      readonly kind: "workload_identity";
    };

export interface AIForwardOptions {
  readonly authentication: AIForwardClientAuthentication;
  readonly acquire: (
    sessionKey: string | undefined,
    signal: AbortSignal,
    authorization: ProviderAuthorizationGrantV1 | undefined,
    telemetry: AIGatewayRequestTelemetry,
  ) => Effect.Effect<AIForwardLease | undefined, AIForwardRouteError>;
  readonly provider: AIProviderHttp["Service"];
  readonly settlements: ProviderBudgetSettlementReporter["Service"];
  readonly now: Effect.Effect<number>;
  readonly heartbeatMillis: number;
  readonly maximumUsageEventBytes: number;
}

export type AIForwardHandler = (
  request: Request,
) => Effect.Effect<Response>;

export const makeAIForwardHandler = Effect.fn(
  "agentos.aiGateway.makeForwardHandler",
)(function*(options: AIForwardOptions) {
  if (
    !Number.isSafeInteger(options.heartbeatMillis) ||
    options.heartbeatMillis < 1 ||
    !Number.isSafeInteger(options.maximumUsageEventBytes) ||
    options.maximumUsageEventBytes < 1
  ) {
    return yield* AIForwardConfigurationError.make({
      code: "invalid_configuration",
    });
  }
  const telemetry = yield* AIGatewayTelemetry;

  const handler: AIForwardHandler = Effect.fn(
    "agentos.aiGateway.forward",
  )(function*(request: Request) {
    const requestTelemetry = yield* telemetry.start(request);
    const urlResult = yield* Effect.result(Effect.try({
      try: () => new URL(request.url),
      catch: () => AIForwardConfigurationError.make({
        code: "invalid_configuration",
      }),
    }));
    if (Result.isFailure(urlResult)) {
      return jsonResponse(400, "invalid_request");
    }
    const url = urlResult.success;
    const authentication = yield* authenticateClient(
      options.authentication,
      request,
      url,
      options.now,
    );
    yield* diagnostic(requestTelemetry.authenticate(
      authentication.authenticated,
      authentication.authenticated
        ? authentication.authorization
        : undefined,
      authentication.authenticated ? undefined : authentication.status,
    ));
    if (!authentication.authenticated) {
      yield* diagnostic(requestTelemetry.end({
        status: authentication.status,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(
        authentication.status,
        authentication.status === 403 ? "forbidden" : "unauthorized",
      );
    }
    if (
      request.method !== "POST" ||
      !isSupportedResponsePath(url.pathname)
    ) {
      yield* diagnostic(requestTelemetry.end({
        status: 404,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(404, "not_found");
    }

    const session = yield* Effect.result(extractSessionKey(request.headers));
    if (Result.isFailure(session)) {
      yield* diagnostic(requestTelemetry.end({
        status: 400,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(400, "invalid_session");
    }
    const sessionKey = attributedSessionKey(
      Option.getOrUndefined(session.success),
      authentication.authorization,
    );
    yield* diagnostic(requestTelemetry.routeStarted);
    const acquired = yield* Effect.result(options.acquire(
      sessionKey,
      request.signal,
      authentication.authorization,
      requestTelemetry,
    ));
    if (Result.isFailure(acquired)) {
      yield* diagnostic(
        requestTelemetry.routeEnded("error", acquired.failure),
      );
      yield* diagnostic(requestTelemetry.end({
        status: 503,
        error: acquired.failure,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(503, "route_unavailable");
    }
    const lease = acquired.success;
    if (lease === undefined) {
      yield* diagnostic(requestTelemetry.routeEnded("unavailable"));
      yield* diagnostic(requestTelemetry.end({
        status: 503,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(503, "no_eligible_account");
    }
    yield* diagnostic(requestTelemetry.routeEnded("acquired"));

    const upstreamRequest = yield* makeUpstreamRequest(request, url, lease);
    if (upstreamRequest === undefined) {
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: 400,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(400, "invalid_request");
    }
    yield* diagnostic(
      requestTelemetry.upstreamStarted(upstreamRequest.headers),
    );
    const upstreamResult = yield* Effect.result(
      options.provider.execute(upstreamRequest),
    );
    if (Result.isFailure(upstreamResult)) {
      yield* diagnostic(
        requestTelemetry.upstreamFailed(upstreamResult.failure),
      );
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: 502,
        error: upstreamResult.failure,
        streamOutcome: request.signal.aborted ? "aborted" : "upstream_error",
      }));
      return jsonResponse(502, providerErrorCode(upstreamResult.failure));
    }
    const upstream = upstreamResult.success;
    const headersResult = yield* Effect.result(Effect.try({
      try: () => new Headers(upstream.headers),
      catch: () => AIForwardConfigurationError.make({
        code: "invalid_configuration",
      }),
    }));
    if (Result.isFailure(headersResult)) {
      yield* diagnostic(
        requestTelemetry.upstreamFailed(headersResult.failure),
      );
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: 502,
        error: headersResult.failure,
        streamOutcome: "upstream_error",
      }));
      return jsonResponse(502, "invalid_provider_response");
    }
    const upstreamHeaders = headersResult.success;
    yield* diagnostic(
      requestTelemetry.upstreamHeaders(upstream.status, upstreamHeaders),
    );
    const responseHeaders = sanitizeResponseHeaders(upstreamHeaders);
    const responseMetadata = yield* Effect.result(finiteResponse(
      null,
      upstream.status,
      responseHeaders,
    ));
    if (Result.isFailure(responseMetadata)) {
      yield* diagnostic(
        requestTelemetry.upstreamFailed(responseMetadata.failure),
      );
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: 502,
        error: responseMetadata.failure,
        streamOutcome: "upstream_error",
      }));
      return jsonResponse(502, "invalid_provider_response");
    }
    yield* recordResponse(lease, upstream.status, upstreamHeaders);
    if (upstream.body === null) {
      yield* settleWithoutBody(
        options.settlements,
        authentication.authorization,
        upstream.status,
      );
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: upstream.status,
        streamOutcome: "not_streamed",
      }));
      return responseMetadata.success;
    }
    if (!responseStatusAllowsBody(upstream.status)) {
      const failure = AIForwardConfigurationError.make({
        code: "invalid_configuration",
      });
      yield* diagnostic(requestTelemetry.upstreamFailed(failure));
      yield* releaseLease(lease, requestTelemetry);
      yield* diagnostic(requestTelemetry.end({
        status: 502,
        error: failure,
        streamOutcome: "upstream_error",
      }));
      return jsonResponse(502, "invalid_provider_response");
    }

    const observerResult = upstream.status < 400 &&
        isEventStream(upstreamHeaders)
      ? yield* Effect.result(makeOpenAITerminalUsageObserver({
        maximumEventBytes: options.maximumUsageEventBytes,
      }))
      : undefined;
    if (observerResult !== undefined && Result.isFailure(observerResult)) {
      yield* releaseLease(lease, requestTelemetry);
      return jsonResponse(503, "accounting_unavailable");
    }
    const observer = observerResult === undefined
      ? undefined
      : observerResult.success;
    const monitored = upstream.body.pipe(
      Stream.tap((chunk) =>
        diagnostic(requestTelemetry.streamChunk(chunk.byteLength))
      ),
      observer === undefined
        ? (stream) => stream
        : Stream.tap((chunk) => observer.observe(chunk)),
      Stream.onExit((exit) =>
        finalizeStream(
          exit,
          lease,
          options.settlements,
          authentication.authorization,
          upstream.status,
          observer,
          requestTelemetry,
          request.signal,
        )
      ),
    );
    const scoped = Stream.unwrap(Effect.gen(function*() {
      yield* heartbeat(lease, options.heartbeatMillis).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      return monitored;
    }));
    const body = yield* Stream.toReadableStreamEffect(scoped);
    const responseResult = yield* Effect.result(finiteResponse(
      body,
      upstream.status,
      responseHeaders,
    ));
    if (Result.isFailure(responseResult)) {
      yield* releaseLease(lease, requestTelemetry);
      return jsonResponse(502, "invalid_provider_response");
    }
    return responseResult.success;
  });
  return handler;
});

type ClientAuthenticationResult =
  | {
      readonly authenticated: true;
      readonly authorization: ProviderAuthorizationGrantV1 | undefined;
    }
  | {
      readonly authenticated: false;
      readonly status: 401 | 403;
    };

function authenticateClient(
  authentication: AIForwardClientAuthentication,
  request: Request,
  url: URL,
  now: Effect.Effect<number>,
): Effect.Effect<ClientAuthenticationResult> {
  if (authentication.kind === "shared_token") {
    return Effect.succeed(
      isClientAuthorized(request, authentication.token)
        ? { authenticated: true, authorization: undefined }
        : { authenticated: false, status: 401 },
    );
  }
  return Effect.gen(function*() {
    const currentTime = yield* now;
    const decoded = yield* Effect.result(
      decodeProviderAuthorizationGrantHeaders(request.headers, {
        method: request.method,
        path: url.pathname,
        nowMillis: currentTime,
      }),
    );
    if (Result.isFailure(decoded)) {
      return {
        authenticated: false,
        status: authorizationFailureStatus(decoded.failure),
      };
    }
    const authorization = decoded.success;
    if (
      authorization.credentialDomain !== "openai-responses" ||
      authorization.resource.kind !== "provider_service" ||
      authorization.resource.provider !== "openai" ||
      authorization.resource.service !== "responses"
    ) {
      return { authenticated: false, status: 403 };
    }
    return { authenticated: true, authorization };
  });
}

function authorizationFailureStatus(
  error: ProviderAuthorizationError,
): 401 | 403 {
  return [
    "grant_route_mismatch",
    "invalid_request",
    "policy_denied",
    "resource_mismatch",
    "unsupported_route",
  ].includes(error.code)
    ? 403
    : 401;
}

function isClientAuthorized(request: Request, expected: string): boolean {
  if (expected.length === 0) return false;
  const dedicated = request.headers.get("x-ai-gateway-token")?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  const actual = dedicated ?? bearer ?? "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function attributedSessionKey(
  sessionKey: string | undefined,
  grant: ProviderAuthorizationGrantV1 | undefined,
): string | undefined {
  if (sessionKey === undefined || grant === undefined) return sessionKey;
  const assignmentId = grant.identity.assignmentId;
  const kind = assignmentId === null ? "mate" : "assignment";
  const id = assignmentId ?? grant.identity.agentId;
  const digest = createHash("sha256")
    .update(`${kind}:${id}`, "utf8")
    .update("\0", "utf8")
    .update(sessionKey, "utf8")
    .digest("hex");
  return `agentos-v1:${kind}:${digest}`;
}

function makeUpstreamRequest(
  request: Request,
  url: URL,
  lease: AIForwardLease,
) {
  return Effect.gen(function*() {
    const headers = sanitizeRequestHeaders(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-agentos-")) headers.delete(name);
    }
    headers.set("accept-encoding", "identity");
    headers.set("authorization", `Bearer ${lease.accessToken}`);
    const accountKind = lease.kind === "codex_oauth"
      ? "codex_subscription"
      : "openai_api_key";
    if (lease.kind === "codex_oauth") {
      if (lease.providerAccountId === undefined) return undefined;
      headers.set("chatgpt-account-id", lease.providerAccountId);
    } else {
      headers.delete("chatgpt-account-id");
    }
    const result = yield* Effect.result(Effect.try({
      try: () => {
        const upstreamUrl = resolveUpstreamTarget(url.pathname, accountKind);
        return new Request(upstreamUrl, {
          method: "POST",
          headers,
          body: request.body,
          signal: request.signal,
          duplex: "half",
        });
      },
      catch: () => AIForwardConfigurationError.make({
        code: "invalid_configuration",
      }),
    }));
    return Result.isSuccess(result) ? result.success : undefined;
  });
}

function heartbeat(lease: AIForwardLease, heartbeatMillis: number) {
  return Effect.sleep(heartbeatMillis).pipe(
    Effect.andThen(lease.renew),
    Effect.flatMap((renewed) => renewed ? Effect.void : Effect.interrupt),
    Effect.forever,
    Effect.catchCause(() => Effect.void),
  );
}

function finalizeStream(
  exit: Exit.Exit<unknown, AIProviderHttpError>,
  lease: AIForwardLease,
  settlements: ProviderBudgetSettlementReporter["Service"],
  authorization: ProviderAuthorizationGrantV1 | undefined,
  status: number,
  observer: OpenAITerminalUsageObserver | undefined,
  telemetry: AIGatewayRequestTelemetry,
  signal: AbortSignal,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    if (authorization !== undefined) {
      if (status >= 400) {
        yield* reportSettlement(
          settlements,
          zeroUsageReport(authorization.decisionRef, "provider_rejected"),
        );
      } else if (observer !== undefined) {
        const usage = yield* Effect.option(observer.finish);
        if (Option.isSome(usage)) {
          yield* reportSettlement(settlements, {
            schemaVersion: 1,
            decisionRef: authorization.decisionRef,
            forwardOutcome: streamOutcome(exit),
            ...usage.value,
          });
        }
      }
    }
    yield* releaseLease(lease, telemetry);
    const outcome = telemetryStreamOutcome(exit, signal);
    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    yield* diagnostic(telemetry.end({
      status,
      streamOutcome: outcome,
      ...(failure === undefined ? {} : { error: failure }),
    }));
  }).pipe(
    Effect.catchCause(() => releaseLease(lease, telemetry)),
    Effect.catchCause(() => Effect.void),
    Effect.uninterruptible,
  );
}

function settleWithoutBody(
  settlements: ProviderBudgetSettlementReporter["Service"],
  authorization: ProviderAuthorizationGrantV1 | undefined,
  status: number,
) {
  return authorization !== undefined && status >= 400
    ? reportSettlement(
      settlements,
      zeroUsageReport(authorization.decisionRef, "provider_rejected"),
    )
    : Effect.void;
}

function zeroUsageReport(
  decisionRef: string,
  forwardOutcome: ProviderBudgetSettlementReportV1["forwardOutcome"],
): ProviderBudgetSettlementReportV1 {
  return {
    schemaVersion: 1,
    decisionRef,
    forwardOutcome,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    spendMicros: 0,
  };
}

function reportSettlement(
  settlements: ProviderBudgetSettlementReporter["Service"],
  report: ProviderBudgetSettlementReportV1,
) {
  return settlements.report(report).pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
    Effect.uninterruptible,
  );
}

function releaseLease(
  lease: AIForwardLease,
  telemetry: AIGatewayRequestTelemetry,
) {
  return Effect.gen(function*() {
    yield* diagnostic(telemetry.routeReleaseStarted);
    const release = yield* Effect.exit(lease.release);
    yield* diagnostic(
      Exit.isSuccess(release)
        ? telemetry.routeReleased
        : telemetry.routeReleaseFailed,
    );
  }).pipe(
    Effect.uninterruptible,
  );
}

function diagnostic(effect: Effect.Effect<void>): Effect.Effect<void> {
  return effect.pipe(Effect.catchCause(() => Effect.void));
}

function recordResponse(
  lease: AIForwardLease,
  status: number,
  headers: Headers,
) {
  return (lease.recordResponse?.(status, headers) ?? Effect.void).pipe(
    Effect.catchCause(() => Effect.void),
  );
}

function streamOutcome(
  exit: Exit.Exit<unknown, AIProviderHttpError>,
): ProviderBudgetSettlementReportV1["forwardOutcome"] {
  if (Exit.isSuccess(exit)) return "completed";
  return Cause.interruptors(exit.cause).size > 0
    ? "cancelled"
    : "transport_failed";
}

function telemetryStreamOutcome(
  exit: Exit.Exit<unknown, AIProviderHttpError>,
  signal: AbortSignal,
): "completed" | "client_disconnect" | "aborted" | "upstream_error" {
  if (Exit.isSuccess(exit)) return "completed";
  if (signal.aborted) return "aborted";
  return Cause.interruptors(exit.cause).size > 0
    ? "client_disconnect"
    : "upstream_error";
}

function isEventStream(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase()
    .split(";", 1)[0]?.trim() === "text/event-stream";
}

function responseStatusAllowsBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function providerErrorCode(error: AIProviderHttpError): string {
  return error.code === "request_invalid"
    ? "invalid_provider_request"
    : "provider_unavailable";
}

function jsonResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function finiteResponse(
  body: ReadableStream<Uint8Array> | null,
  status: number,
  headers: Headers,
) {
  return Effect.try({
    try: () => new Response(body, { status, headers }),
    catch: () => AIForwardConfigurationError.make({
      code: "invalid_configuration",
    }),
  });
}
