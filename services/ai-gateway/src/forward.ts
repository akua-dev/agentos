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
  type ProviderBudgetAttemptRenewalReporter,
  type ProviderBudgetSettlementReportV1,
} from "@akua-dev/agentos";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";

import { attributedSessionKey } from "./attribution.ts";
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

export type AIForwardClientAuthentication = { readonly kind: "workload_identity" };

export interface AIForwardOptions {
  readonly authentication: AIForwardClientAuthentication;
  readonly acquire: <A>(
    sessionKey: string | undefined,
    signal: AbortSignal,
    authorization: ProviderAuthorizationGrantV1 | undefined,
    telemetry: AIGatewayRequestTelemetry,
    use: (
      lease: AIForwardLease | undefined,
      transfer: Effect.Effect<void>,
    ) => Effect.Effect<A, AIForwardRouteError>,
  ) => Effect.Effect<A, AIForwardRouteError>;
  readonly provider: AIProviderHttp["Service"];
  readonly settlements: ProviderBudgetSettlementReporter["Service"];
  readonly attemptRenewals?: ProviderBudgetAttemptRenewalReporter["Service"];
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
  const crypto = yield* Crypto.Crypto;

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
      authentication.authorization !== undefined &&
      "model" in authentication.authorization
    ) {
      const bounded = yield* Effect.result(validateWorkloadRequestCeiling(
        request,
        authentication.authorization,
      ));
      if (Result.isFailure(bounded)) {
        yield* diagnostic(requestTelemetry.end({
          status: 403,
          streamOutcome: "not_streamed",
        }));
        return jsonResponse(403, "forbidden");
      }
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
    const attributed = yield* Effect.result(attributedSessionKey(
      Option.getOrUndefined(session.success),
      authentication.authorization,
    ).pipe(Effect.provideService(Crypto.Crypto, crypto)));
    if (Result.isFailure(attributed)) {
      const status = attributed.failure.code === "disabled_grant" ? 403 : 503;
      yield* diagnostic(requestTelemetry.end({
        status,
        error: attributed.failure,
        streamOutcome: "not_streamed",
      }));
      return jsonResponse(
        status,
        status === 403 ? "forbidden" : "attribution_unavailable",
      );
    }
    const sessionKey = attributed.success;
    yield* diagnostic(requestTelemetry.routeStarted);
    return yield* options.acquire(
      sessionKey,
      request.signal,
      authentication.authorization,
      requestTelemetry,
      (lease, transfer) => {
        if (lease === undefined) {
          return Effect.gen(function*() {
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* diagnostic(requestTelemetry.routeEnded("unavailable"));
            yield* diagnostic(requestTelemetry.end({
              status: 503,
              streamOutcome: "not_streamed",
            }));
            return jsonResponse(503, "no_eligible_account");
          });
        }
        return Effect.gen(function*() {
          type LeaseReleaseState = "available" | "releasing" | "released";
          const leaseReleaseState = yield* Ref.make<LeaseReleaseState>("available");
          const transferLease = Effect.uninterruptible(transfer);
          const releaseLeaseOnce = Effect.uninterruptible(Effect.gen(function*() {
            const action = yield* Ref.modify(
              leaseReleaseState,
              (state): readonly ["attempt" | "done" | "wait", LeaseReleaseState] =>
                state === "available"
                  ? ["attempt", "releasing"]
                  : state === "released"
                  ? ["done", state]
                  : ["wait", state],
            );
            if (action === "done") return true;
            if (action === "wait") return false;
            const released = yield* releaseLease(lease, requestTelemetry);
            if (released) {
              yield* Ref.set(leaseReleaseState, "released");
              yield* transferLease;
              return true;
            }
            yield* Ref.set(leaseReleaseState, "available");
            return false;
          }));

          yield* diagnostic(requestTelemetry.routeEnded("acquired"));
          const upstreamRequest = yield* makeUpstreamRequest(request, url, lease);
          if (upstreamRequest === undefined) {
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
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
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
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
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
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
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
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
            yield* releaseLeaseOnce;
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
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
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
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
            return jsonResponse(503, "accounting_unavailable");
          }
          const observer = observerResult === undefined
            ? undefined
            : observerResult.success;
          const heartbeatFailed = yield* Ref.make(false);
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
                releaseLeaseOnce,
                options.settlements,
                authentication.authorization,
                upstream.status,
                observer,
                requestTelemetry,
                request.signal,
                heartbeatFailed,
              )
            ),
          );
          const scoped = Stream.unwrap(Effect.gen(function*() {
            if (options.attemptRenewals === undefined) return monitored;
            const heartbeatFailure = yield* Deferred.make<void>();
            yield* heartbeat(
              lease,
              options.attemptRenewals,
              authentication.authorization?.decisionRef,
              options.heartbeatMillis,
              heartbeatFailure,
              heartbeatFailed,
            ).pipe(
              Effect.forkScoped({ startImmediately: true }),
            );
            return monitored.pipe(Stream.interruptWhen(Deferred.await(heartbeatFailure)));
          }));
          const body = yield* Stream.toReadableStreamEffect(scoped);
          const responseResult = yield* Effect.result(finiteResponse(
            body,
            upstream.status,
            responseHeaders,
          ));
          if (Result.isFailure(responseResult)) {
            yield* settleAttempt(
              options.settlements,
              authentication.authorization,
              "transport_failed",
            );
            yield* releaseLeaseOnce;
            return jsonResponse(502, "invalid_provider_response");
          }
          return yield* Effect.uninterruptible(Effect.gen(function*() {
            yield* transferLease;
            return responseResult.success;
          }));
        });
      },
    ).pipe(
      Effect.catchTag("AIForwardRouteError", (failure) =>
        Effect.gen(function*() {
          yield* settleAttempt(
            options.settlements,
            authentication.authorization,
            "transport_failed",
          );
          yield* diagnostic(requestTelemetry.routeEnded("error", failure));
          yield* diagnostic(requestTelemetry.end({
            status: 503,
            error: failure,
            streamOutcome: "not_streamed",
          }));
          return jsonResponse(503, "route_unavailable");
        })
      ),
    );
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
  return Effect.gen(function*() {
    const currentTime = yield* now;
    const body = request.headers.get("x-agentos-authz-principal-kind") ===
        "kubernetes_workload"
      ? yield* Effect.result(Effect.tryPromise({
        try: () => request.clone().text(),
        catch: () => AIForwardConfigurationError.make({
          code: "invalid_configuration",
        }),
      }))
      : undefined;
    if (body !== undefined && Result.isFailure(body)) {
      return { authenticated: false, status: 401 };
    }
    const decoded = yield* Effect.result(
      decodeProviderAuthorizationGrantHeaders(request.headers, {
        method: request.method,
        path: url.pathname,
        nowMillis: currentTime,
        ...(body === undefined ? {} : { body: body.success }),
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

const WorkloadResponsesRequestSchema = Schema.fromJsonString(Schema.Struct({
  model: Schema.String,
  stream: Schema.Literal(true),
  max_output_tokens: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
}));

function validateWorkloadRequestCeiling(
  request: Request,
  grant: Extract<ProviderAuthorizationGrantV1, { readonly model: string }>,
) {
  return Effect.tryPromise({
    try: () => request.clone().text(),
    catch: () => AIForwardConfigurationError.make({ code: "invalid_configuration" }),
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(WorkloadResponsesRequestSchema)(body).pipe(
        Effect.map((payload) => ({ body, payload })),
      )
    ),
    Effect.filterOrFail(
      ({ body, payload }) =>
        payload.model === grant.model && (() => {
          const inputCeiling = new TextEncoder().encode(body).byteLength;
          const requestedTokens = inputCeiling + payload.max_output_tokens;
          const requestedSpendMicros = pricedSpend(
            inputCeiling,
            payload.max_output_tokens,
            grant.pricing.inputMicrosPerMillionTokens,
            grant.pricing.outputMicrosPerMillionTokens,
          );
          return Number.isSafeInteger(requestedTokens) &&
            requestedTokens === grant.requestedTokens &&
            requestedTokens <= grant.limits.maximumTokens &&
            requestedSpendMicros === grant.requestedSpendMicros &&
            requestedSpendMicros <= grant.limits.maximumSpendMicros;
        })(),
      () => AIForwardConfigurationError.make({ code: "invalid_configuration" }),
    ),
    Effect.asVoid,
  );
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

function heartbeat(
  lease: AIForwardLease,
  attemptRenewals: ProviderBudgetAttemptRenewalReporter["Service"],
  decisionRef: string | undefined,
  heartbeatMillis: number,
  failure: Deferred.Deferred<void>,
  failed: Ref.Ref<boolean>,
) {
  return Effect.sleep(heartbeatMillis).pipe(
    Effect.andThen(Effect.all([
      lease.renew,
      decisionRef === undefined
        ? Effect.succeed(false)
        : attemptRenewals.renew({ schemaVersion: 1, decisionRef }).pipe(Effect.as(true)),
    ])),
    Effect.flatMap(([routerRenewed, attemptRenewed]) => routerRenewed && attemptRenewed
      ? Effect.void
      : Ref.set(failed, true).pipe(
        Effect.andThen(Deferred.succeed(failure, undefined)),
        Effect.andThen(Effect.interrupt),
      )),
    Effect.catch((error) =>
      Ref.set(failed, true).pipe(
        Effect.andThen(Deferred.succeed(failure, undefined)),
        Effect.andThen(Effect.fail(error)),
      )
    ),
    Effect.forever,
  );
}

function finalizeStream(
  exit: Exit.Exit<unknown, AIProviderHttpError>,
  releaseLeaseOnce: Effect.Effect<boolean>,
  settlements: ProviderBudgetSettlementReporter["Service"],
  authorization: ProviderAuthorizationGrantV1 | undefined,
  status: number,
  observer: OpenAITerminalUsageObserver | undefined,
  telemetry: AIGatewayRequestTelemetry,
  signal: AbortSignal,
  heartbeatFailed: Ref.Ref<boolean>,
): Effect.Effect<void> {
  const maximumReleaseAttempts = 3;
  let attempts = 0;
  let released = false;
  const releaseStreamLease = Effect.whileLoop({
    while: () => !released && attempts < maximumReleaseAttempts,
    body: () => releaseLeaseOnce.pipe(
      Effect.flatMap((attempted) =>
        attempted || attempts + 1 >= maximumReleaseAttempts
          ? Effect.succeed(attempted)
          : Effect.sleep(1_000).pipe(Effect.as(false))
      ),
    ),
    step: (attempted) => {
      attempts += 1;
      released = attempted;
    },
  });
  return Effect.gen(function*() {
    const failedHeartbeat = yield* Ref.get(heartbeatFailed);
    if (authorization !== undefined) {
      if (status >= 400) {
        yield* reportSettlement(
          settlements,
          zeroUsageReport(authorization.decisionRef, "provider_rejected"),
        );
      } else if (observer !== undefined) {
        const usage = yield* Effect.option(observer.finish);
        if (Option.isSome(usage)) {
          const spendMicros = "model" in authorization
            ? pricedSpend(
              usage.value.inputTokens,
              usage.value.outputTokens,
              authorization.pricing.inputMicrosPerMillionTokens,
              authorization.pricing.outputMicrosPerMillionTokens,
            )
            : usage.value.spendMicros;
          yield* reportSettlement(settlements, {
            schemaVersion: 1,
            decisionRef: authorization.decisionRef,
            forwardOutcome: streamOutcome(exit, failedHeartbeat),
            ...usage.value,
            spendMicros,
          });
        } else if (Exit.isSuccess(exit)) {
          return yield* Effect.die("successful provider stream omitted terminal usage");
        } else {
          yield* reportSettlement(settlements, zeroUsageReport(
            authorization.decisionRef,
            streamOutcome(exit, failedHeartbeat),
          ));
        }
      } else if (status < 400 && Exit.isSuccess(exit)) {
        return yield* Effect.die("successful provider response was not an accounted event stream");
      } else {
        yield* reportSettlement(
          settlements,
          zeroUsageReport(authorization.decisionRef, streamOutcome(exit, failedHeartbeat)),
        );
      }
    }
    yield* releaseStreamLease;
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
    Effect.catchCause((cause) =>
      releaseStreamLease.pipe(Effect.andThen(Effect.failCause(cause)))
    ),
    Effect.uninterruptible,
  );
}

function pricedSpend(
  inputTokens: number,
  outputTokens: number,
  inputMicrosPerMillionTokens: number,
  outputMicrosPerMillionTokens: number,
) {
  const numerator = inputTokens * inputMicrosPerMillionTokens +
    outputTokens * outputMicrosPerMillionTokens;
  return Number.isSafeInteger(numerator) && numerator > 0
    ? Math.ceil(numerator / 1_000_000)
    : Number.NaN;
}

function settleWithoutBody(
  settlements: ProviderBudgetSettlementReporter["Service"],
  authorization: ProviderAuthorizationGrantV1 | undefined,
  status: number,
) {
  return settleAttempt(
    settlements,
    authorization,
    status >= 400 ? "provider_rejected" : "completed",
  );
}

function settleAttempt(
  settlements: ProviderBudgetSettlementReporter["Service"],
  authorization: ProviderAuthorizationGrantV1 | undefined,
  outcome: ProviderBudgetSettlementReportV1["forwardOutcome"],
) {
  return authorization === undefined
    ? Effect.void
    : reportSettlement(
      settlements,
      zeroUsageReport(authorization.decisionRef, outcome),
    );
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
    Effect.retry({ times: 2 }),
    Effect.orDie,
    Effect.asVoid,
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
    return Exit.isSuccess(release);
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
  heartbeatFailed = false,
): ProviderBudgetSettlementReportV1["forwardOutcome"] {
  if (Exit.isSuccess(exit)) return "completed";
  if (heartbeatFailed) return "transport_failed";
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
