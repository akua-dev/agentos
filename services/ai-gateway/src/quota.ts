import { AccountId } from "@akua-dev/codex-router/core";
import { decodeCodexUsage } from "@akua-dev/codex-router/codex";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";

import type { UsageSnapshot } from "./types.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MILLIS = 5_000;

const CodexQuotaErrorCode = Schema.Literals([
  "needs_reauthentication",
  "provider_rejected",
  "provider_unavailable",
  "invalid_response",
]);

export class CodexQuotaError extends Schema.TaggedErrorClass<CodexQuotaError>()(
  "CodexQuotaError",
  {
    code: CodexQuotaErrorCode,
    status: Schema.NullOr(Schema.Number),
  },
) {}

export interface CodexQuotaObservationInput {
  readonly accessToken: string;
  readonly providerAccountId: string;
  readonly managedAccountId: string;
}

export class CodexQuota extends Context.Service<
  CodexQuota,
  {
    readonly observe: (
      input: CodexQuotaObservationInput,
    ) => Effect.Effect<UsageSnapshot, CodexQuotaError>;
  }
>()("agentos/ai-gateway/CodexQuota") {}

export function makeCodexQuotaLayer(timeoutMillis: number) {
  return Layer.effect(
    CodexQuota,
    Effect.gen(function*() {
      if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1) {
        return yield* quotaError("provider_unavailable", null);
      }
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const observe = Effect.fn("agentos.aiGateway.codexQuota.observe")(
        function*(input: CodexQuotaObservationInput) {
          const request = HttpClientRequest.get(CODEX_USAGE_URL).pipe(
            HttpClientRequest.setHeader("accept", "application/json"),
            HttpClientRequest.setHeader(
              "authorization",
              `Bearer ${input.accessToken}`,
            ),
            HttpClientRequest.setHeader(
              "chatgpt-account-id",
              input.providerAccountId,
            ),
          );
          return yield* Effect.gen(function*() {
            const response = yield* client.execute(request).pipe(
              Effect.mapError(() => quotaError("provider_unavailable", null)),
            );
            if (response.status === 401) {
              return yield* quotaError(
                "needs_reauthentication",
                response.status,
              );
            }
            if (response.status < 200 || response.status >= 300) {
              return yield* quotaError("provider_rejected", response.status);
            }
            const body = yield* response.json.pipe(
              Effect.mapError(() =>
                quotaError("invalid_response", response.status)
              ),
            );
            const observedAt = yield* Clock.currentTimeMillis;
            const decoded = yield* decodeCodexUsage(
              body,
              observedAt,
              AccountId.make(input.managedAccountId),
            ).pipe(
              Effect.mapError(() =>
                quotaError("invalid_response", response.status)
              ),
            );
            return {
              accountId: input.managedAccountId,
              observedAt: decoded.observedAt,
              shortWindow: {
                usedPercent: decoded.short.usedPercent,
                ...(decoded.short.resetAt === undefined
                  ? {}
                  : { resetsAt: decoded.short.resetAt }),
              },
              weeklyWindow: {
                usedPercent: decoded.weekly.usedPercent,
                ...(decoded.weekly.resetAt === undefined
                  ? {}
                  : { resetsAt: decoded.weekly.resetAt }),
              },
              stale: decoded.stale ?? false,
              ...(decoded.planType === undefined
                ? {}
                : { planType: decoded.planType }),
              ...(decoded.credits === undefined
                ? {}
                : { creditsRemaining: decoded.credits }),
            } satisfies UsageSnapshot;
          }).pipe(
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: timeoutMillis,
              orElse: () => quotaError("provider_unavailable", null),
            }),
          );
        },
      );
      return CodexQuota.of({ observe });
    }),
  );
}

export const CodexQuotaLive = makeCodexQuotaLayer(DEFAULT_TIMEOUT_MILLIS);

function quotaError(
  code: CodexQuotaError["code"],
  status: number | null,
) {
  return CodexQuotaError.make({ code, status });
}
