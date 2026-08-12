import {
  AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
  PROVIDER_AUTHORIZATION_GRANT_HEADERS,
  ProviderBudgetReservationAcceptanceV1Schema,
  ProviderBudgetReservationRequester,
  ProviderBudgetSettlementReadiness,
  ProviderBudgetSettlementReporter,
  denyProviderBudgetReservationRequester,
  providerAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
  type ProviderBudgetReservationRequestV1,
} from "@akua-dev/agentos";
import {
  Clock,
  Effect,
  Exit,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";

import { timingSafeStringEqual } from "./constant-time.ts";
import {
  AIForwardRouteError,
  makeAIForwardHandler,
  type AIForwardClientAuthentication,
  type AIForwardLease,
} from "./forward.ts";
import { AIProviderHttp } from "./provider-http.ts";
import type { AIGatewayRequestTelemetry } from "./observability.ts";
import { CodexQuota } from "./quota.ts";
import {
  AIRoutingState,
  ManagedAccountVault,
  type ManagedAccountVaultError,
} from "./state.ts";
import type { Candidate, UsageSnapshot } from "./types.ts";

const AIGatewayApplicationErrorCode = Schema.Literals([
  "invalid_configuration",
]);

export class AIGatewayApplicationError extends Schema.TaggedErrorClass<AIGatewayApplicationError>()(
  "AIGatewayApplicationError",
  { code: AIGatewayApplicationErrorCode },
) {}

export interface AIGatewayApplicationOptions {
  readonly authentication: AIForwardClientAuthentication;
  readonly operatorToken: string;
  readonly allowApiKeyFallback: boolean;
  readonly openAIApiKey?: string;
  readonly heartbeatMillis: number;
  readonly maximumUsageEventBytes: number;
  readonly usageCacheMillis: number;
}

export interface AIGatewayApplication {
  readonly handle: (request: Request) => Effect.Effect<Response>;
}

interface CandidateSet {
  readonly hasCredential: boolean;
  readonly candidates: ReadonlyArray<Candidate>;
}

export const makeAIGatewayApplication = Effect.fn(
  "agentos.aiGateway.makeApplication",
)(function*(options: AIGatewayApplicationOptions) {
  if (
    !Number.isSafeInteger(options.heartbeatMillis) ||
    options.heartbeatMillis < 1 ||
    !Number.isSafeInteger(options.maximumUsageEventBytes) ||
    options.maximumUsageEventBytes < 1 ||
    !Number.isSafeInteger(options.usageCacheMillis) ||
    options.usageCacheMillis < 1 ||
    options.operatorToken.length > 16 * 1_024 ||
    (options.authentication.kind === "shared_token" &&
      options.authentication.token.length === 0)
  ) {
    return yield* AIGatewayApplicationError.make({
      code: "invalid_configuration",
    });
  }
  const vault = yield* ManagedAccountVault;
  const routing = yield* AIRoutingState;
  const quota = yield* CodexQuota;
  const provider = yield* AIProviderHttp;
  const budgetReservations = Option.getOrElse(
    yield* Effect.serviceOption(ProviderBudgetReservationRequester),
    () => denyProviderBudgetReservationRequester,
  );
  const settlementReadiness = yield* ProviderBudgetSettlementReadiness;
  const settlements = yield* ProviderBudgetSettlementReporter;
  const usage = yield* Ref.make<ReadonlyMap<string, UsageSnapshot>>(new Map());

  const fallbackKey = options.openAIApiKey?.trim();
  const fallbackAvailable = options.allowApiKeyFallback &&
    fallbackKey !== undefined && fallbackKey.length > 0;

  const candidateSet = Effect.fn("agentos.aiGateway.loadCandidates")(
    function*(telemetry?: AIGatewayRequestTelemetry) {
      const currentTime = yield* Clock.currentTimeMillis;
      const accountResult = yield* Effect.result(vault.list);
      if (Result.isFailure(accountResult)) {
        return yield* routeError("state_unavailable");
      }
      const accounts = accountResult.success;
      const cachedUsage = yield* Ref.get(usage);
      const candidates = yield* Effect.forEach(
        accounts,
        (account) =>
          candidateForAccount(
            account,
            currentTime,
            cachedUsage.get(account.id),
            options.usageCacheMillis,
            vault,
            quota,
            usage,
            telemetry,
          ),
        { concurrency: 4 },
      );
      return {
        hasCredential: accounts.some((account) => !account.needsReauth),
        candidates,
      } satisfies CandidateSet;
    },
  );

  const acquire = Effect.fn("agentos.aiGateway.acquireRoute")(
    function*<A>(
      sessionKey: string | undefined,
      _signal: AbortSignal,
      authorization: ProviderAuthorizationGrantV1 | undefined,
      telemetry: AIGatewayRequestTelemetry,
      use: (
        lease: AIForwardLease | undefined,
        transfer: Effect.Effect<void>,
      ) => Effect.Effect<A, AIForwardRouteError>,
    ): Effect.fn.Return<A, AIForwardRouteError> {
      if (authorization !== undefined && "model" in authorization) {
        const request = {
          schemaVersion: 1,
          grant: authorization,
          subject: authorization.identity,
        } satisfies ProviderBudgetReservationRequestV1;
        const acceptanceExit = yield* Effect.exit(Effect.suspend(() =>
          budgetReservations.request(request)
        ));
        if (Exit.isFailure(acceptanceExit)) {
          return yield* routeError("state_unavailable");
        }
        const acceptanceResult = yield* Effect.result(
          Schema.decodeUnknownEffect(
            ProviderBudgetReservationAcceptanceV1Schema,
            { onExcessProperty: "error" },
          )(acceptanceExit.value),
        );
        if (
          Result.isFailure(acceptanceResult) ||
          !reservationAcceptanceMatches(request, acceptanceResult.success)
        ) {
          return yield* routeError("state_unavailable");
        }
      }
      const set = yield* candidateSet(telemetry);
      const currentTime = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        set.candidates,
        (candidate) =>
          candidate.usage === undefined
            ? Effect.void
            : telemetry.quotaObservation(
              quotaObservationAgeSeconds(
                currentTime,
                candidate.usage.observedAt,
              ),
              candidate.usage.stale,
            ).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true },
      );
      return yield* routing.acquire({
        candidates: set.candidates,
        now: currentTime,
        ...(sessionKey === undefined ? {} : { sessionKey }),
      }, (reservation, transfer) => {
        if (reservation === undefined) {
          return use(
            fallbackAvailable && fallbackKey !== undefined
              ? fallbackLease(fallbackKey)
              : undefined,
            Effect.void,
          );
        }
        return Effect.gen(function*() {
          const credential = yield* vault.getFreshCredential(
            reservation.accountId,
          ).pipe(
            Effect.mapError((error) =>
              routeError(routeCodeForAccount(error))
            ),
          );
          type ReleaseState = "available" | "releasing" | "released";
          const releaseState = yield* Ref.make<ReleaseState>("available");
          const release = Effect.uninterruptible(Effect.gen(function*() {
            const action = yield* Ref.modify(
              releaseState,
              (state): readonly ["attempt" | "done" | "wait", ReleaseState] =>
                state === "available"
                  ? ["attempt", "releasing"]
                  : state === "released"
                  ? ["done", state]
                  : ["wait", state],
            );
            if (action !== "attempt") return;
            const released = yield* Effect.exit(
              routing.release(reservation.leaseToken).pipe(
                Effect.asVoid,
                Effect.mapError(() => routeError("state_unavailable")),
              ),
            );
            if (Exit.isSuccess(released)) {
              yield* Ref.set(releaseState, "released");
              return;
            }
            yield* Ref.set(releaseState, "available");
            return yield* Effect.failCause(released.cause);
          }));
          const lease: AIForwardLease = {
            kind: "codex_oauth",
            accessToken: credential.accessToken,
            providerAccountId: credential.providerAccountId,
            renew: Clock.currentTimeMillis.pipe(
              Effect.flatMap((renewedAt) =>
                routing.renew(reservation.leaseToken, renewedAt)
              ),
              Effect.mapError(() => routeError("state_unavailable")),
            ),
            release,
            recordResponse: (status, headers) =>
              Effect.gen(function*() {
                const responseAt = yield* Clock.currentTimeMillis;
                if (status === 401) {
                  yield* vault.markNeedsReauth(
                    reservation.accountId,
                    credential.accessToken,
                  ).pipe(Effect.catchCause(() => Effect.succeed(false)));
                }
                yield* routing.recordResponse(
                  reservation.accountId,
                  status,
                  headers,
                  responseAt,
                ).pipe(
                  Effect.mapError(() => routeError("state_unavailable")),
                );
              }),
          };
          return yield* use(lease, transfer);
        });
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "AIForwardRouteError"
            ? error
            : routeError("routing_unavailable")
        ),
      );
    },
  );

  const forward = yield* makeAIForwardHandler({
    authentication: options.authentication,
    acquire: (sessionKey, signal, authorization, telemetry, use) =>
      acquire(sessionKey, signal, authorization, telemetry, use),
    provider,
    settlements,
    now: Clock.currentTimeMillis,
    heartbeatMillis: options.heartbeatMillis,
    maximumUsageEventBytes: options.maximumUsageEventBytes,
  });

  const readiness = Effect.fn("agentos.aiGateway.readiness")(function*() {
    const settlementResult = yield* Effect.result(settlementReadiness.check);
    if (Result.isFailure(settlementResult)) {
      return notReadyDiagnostic("budget_settlement_unavailable");
    }
    if (fallbackAvailable) return readyDiagnostic;
    const setResult = yield* Effect.result(candidateSet());
    if (Result.isFailure(setResult)) {
      return notReadyDiagnostic("provider_credential_unavailable");
    }
    const set = setResult.success;
    const currentTime = yield* Clock.currentTimeMillis;
    const decisionResult = yield* Effect.result(routing.evaluate({
      candidates: set.candidates,
      now: currentTime,
    }));
    if (
      Result.isSuccess(decisionResult) &&
      decisionResult.success.accountId !== undefined
    ) {
      return readyDiagnostic;
    }
    if (set.hasCredential) {
      const capacityUnknown = Result.isSuccess(decisionResult) &&
        decisionResult.success.candidates.some(({ rejectionCode }) =>
          rejectionCode === "usage_unknown"
        );
      return degradedDiagnostic(
        capacityUnknown
          ? "provider_capacity_unknown"
          : "provider_capacity_degraded",
      );
    }
    return notReadyDiagnostic("provider_credential_unavailable");
  });

  const handle = Effect.fn("agentos.aiGateway.handleRequest")(
    function*(request: Request) {
      const urlResult = yield* Effect.result(Effect.try({
        try: () => new URL(request.url),
        catch: () => AIGatewayApplicationError.make({
          code: "invalid_configuration",
        }),
      }));
      if (Result.isFailure(urlResult)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const path = urlResult.success.pathname;
      if (request.method === "GET" && path === "/healthz") {
        return Response.json({ status: "ok" });
      }
      if (request.method === "GET" && path === "/readyz") {
        const diagnostic = yield* readiness();
        return Response.json(diagnostic, {
          status: diagnostic.status === "not_ready" ? 503 : 200,
        });
      }
      if (request.method === "GET" && path === "/readyz/client") {
        if (!isOperatorAuthorized(request, options.operatorToken)) {
          return Response.json({
            reasons: ["client_unauthorized"],
            status: "not_ready",
            version: 1,
          }, { status: 401 });
        }
        const diagnostic = yield* readiness();
        return Response.json(diagnostic, {
          status: diagnostic.status === "not_ready" ? 503 : 200,
        });
      }
      if (request.method === "GET" && path === "/status") {
        if (!isOperatorAuthorized(request, options.operatorToken)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return yield* statusResponse(
          vault,
          routing,
          usage,
          fallbackAvailable,
        );
      }
      return yield* forward(request);
    },
  );
  return { handle } satisfies AIGatewayApplication;
});

function candidateForAccount(
  account: {
    readonly id: string;
    readonly label: string;
    readonly needsReauth: boolean;
  },
  currentTime: number,
  cached: UsageSnapshot | undefined,
  usageCacheMillis: number,
  vault: ManagedAccountVault["Service"],
  quota: CodexQuota["Service"],
  cache: Ref.Ref<ReadonlyMap<string, UsageSnapshot>>,
  telemetry?: AIGatewayRequestTelemetry,
): Effect.Effect<Candidate> {
  if (account.needsReauth) {
    return Effect.succeed({
      accountId: account.id,
      label: account.label,
      needsReauth: true,
    });
  }
  if (cached !== undefined && currentTime - cached.observedAt < usageCacheMillis) {
    const candidate = {
      accountId: account.id,
      label: account.label,
      needsReauth: false,
      usage: cached,
    } satisfies Candidate;
    return quotaRefreshTelemetry(telemetry, "cache_hit").pipe(
      Effect.as(candidate),
    );
  }
  return Effect.gen(function*() {
    const credentialResult = yield* Effect.result(
      vault.getFreshCredential(account.id),
    );
    if (Result.isFailure(credentialResult)) {
      yield* quotaRefreshTelemetry(
        telemetry,
        "failed",
        credentialResult.failure,
      );
      return staleOrUnknownCandidate(
        account,
        cached,
        credentialResult.failure.code === "needs_reauthentication",
      );
    }
    const credential = credentialResult.success;
    const quotaResult = yield* Effect.result(quota.observe({
      accessToken: credential.accessToken,
      providerAccountId: credential.providerAccountId,
      managedAccountId: account.id,
    }));
    if (Result.isFailure(quotaResult)) {
      yield* quotaRefreshTelemetry(telemetry, "failed", quotaResult.failure);
      if (quotaResult.failure.code === "needs_reauthentication") {
        yield* vault.markNeedsReauth(
          account.id,
          credential.accessToken,
        ).pipe(Effect.catchCause(() => Effect.succeed(false)));
        return staleOrUnknownCandidate(account, cached, true);
      }
      return staleOrUnknownCandidate(account, cached, false);
    }
    const snapshot = quotaResult.success;
    yield* quotaRefreshTelemetry(
      telemetry,
      snapshot.stale ? "stale" : "fresh",
    );
    yield* Ref.update(cache, (current) => {
      const updated = new Map(current);
      updated.set(account.id, snapshot);
      return updated;
    });
    return {
      accountId: account.id,
      label: account.label,
      needsReauth: false,
      usage: snapshot,
    } satisfies Candidate;
  });
}

function quotaRefreshTelemetry(
  telemetry: AIGatewayRequestTelemetry | undefined,
  outcome: "cache_hit" | "fresh" | "stale" | "failed",
  error?: unknown,
): Effect.Effect<void> {
  return telemetry === undefined
    ? Effect.void
    : telemetry.quotaRefresh(outcome, error).pipe(
        Effect.catchCause(() => Effect.void),
      );
}

function staleOrUnknownCandidate(
  account: { readonly id: string; readonly label: string },
  cached: UsageSnapshot | undefined,
  needsReauth: boolean,
): Candidate {
  return {
    accountId: account.id,
    label: account.label,
    needsReauth,
    ...(cached === undefined ? {} : { usage: { ...cached, stale: true } }),
  };
}

function quotaObservationAgeSeconds(now: number, observedAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(observedAt)) return 0;
  return Math.min(
    AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
    Math.max(0, now - observedAt) / 1_000,
  );
}

function fallbackLease(accessToken: string): AIForwardLease {
  return {
    kind: "openai_api_key",
    accessToken,
    renew: Effect.succeed(true),
    release: Effect.void,
    recordResponse: () => Effect.void,
  };
}

function routeCodeForAccount(
  error: ManagedAccountVaultError,
): AIForwardRouteError["code"] {
  return error.code === "needs_reauthentication" ||
      error.code === "invalid_credential" ||
      error.code === "account_not_found"
    ? "credential_unavailable"
    : "state_unavailable";
}

function routeError(code: AIForwardRouteError["code"]) {
  return AIForwardRouteError.make({ code });
}

function reservationAcceptanceMatches(
  request: ProviderBudgetReservationRequestV1,
  acceptance: typeof ProviderBudgetReservationAcceptanceV1Schema.Type,
): boolean {
  const expectedHeaders = providerAuthorizationGrantHeaders(request.grant);
  const acceptedHeaders = providerAuthorizationGrantHeaders(acceptance.grant);
  return PROVIDER_AUTHORIZATION_GRANT_HEADERS.every((name) =>
    expectedHeaders.get(name) === acceptedHeaders.get(name)
  ) &&
    request.subject.kind === acceptance.subject.kind &&
    request.subject.namespace === acceptance.subject.namespace &&
    request.subject.serviceAccountName === acceptance.subject.serviceAccountName &&
    request.subject.policyRevision === acceptance.subject.policyRevision &&
    request.subject.policyResourceVersion ===
      acceptance.subject.policyResourceVersion &&
    request.subject.hermesProfile === acceptance.subject.hermesProfile;
}

function isOperatorAuthorized(request: Request, expected: string): boolean {
  if (expected.length === 0) return false;
  const dedicated = request.headers.get("x-ai-gateway-token")?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  return timingSafeStringEqual(dedicated ?? bearer ?? "", expected);
}

function statusResponse(
  vault: ManagedAccountVault["Service"],
  routing: AIRoutingState["Service"],
  usage: Ref.Ref<ReadonlyMap<string, UsageSnapshot>>,
  fallbackAvailable: boolean,
) {
  return Effect.gen(function*() {
    const accountsResult = yield* Effect.result(vault.list);
    const currentTime = yield* Clock.currentTimeMillis;
    const routingResult = yield* Effect.result(routing.summary(currentTime));
    if (Result.isFailure(accountsResult) || Result.isFailure(routingResult)) {
      return Response.json({ error: "state_unavailable" }, { status: 503 });
    }
    const snapshots = yield* Ref.get(usage);
    return Response.json({
      accounts: accountsResult.success.map((account) => {
        const snapshot = snapshots.get(account.id);
        return {
          id: account.id,
          label: account.label,
          needsReauth: account.needsReauth,
          expiresAt: account.expiresAt,
          ...(snapshot === undefined
            ? {}
            : {
              usage: {
                observedAt: snapshot.observedAt,
                stale: snapshot.stale,
                ...(snapshot.shortWindow === undefined
                  ? {}
                  : { shortWindow: snapshot.shortWindow }),
                ...(snapshot.weeklyWindow === undefined
                  ? {}
                  : { weeklyWindow: snapshot.weeklyWindow }),
              },
            }),
        };
      }),
      apiKeyFallback: fallbackAvailable,
      routing: routingResult.success,
    });
  });
}

type GatewayDiagnosticReason =
  | "budget_settlement_unavailable"
  | "provider_capacity_degraded"
  | "provider_capacity_unknown"
  | "provider_credential_unavailable";

interface GatewayDiagnostic {
  readonly reasons: ReadonlyArray<GatewayDiagnosticReason>;
  readonly status: "ready" | "degraded" | "not_ready";
  readonly version: 1;
}

const readyDiagnostic: GatewayDiagnostic = {
  reasons: [],
  status: "ready",
  version: 1,
};

function degradedDiagnostic(reason: GatewayDiagnosticReason): GatewayDiagnostic {
  return { reasons: [reason], status: "degraded", version: 1 };
}

function notReadyDiagnostic(reason: GatewayDiagnosticReason): GatewayDiagnostic {
  return { reasons: [reason], status: "not_ready", version: 1 };
}
