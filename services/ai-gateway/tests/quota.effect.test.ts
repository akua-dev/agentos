import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  CodexQuota,
  CodexQuotaError,
  CodexQuotaLive,
} from "../src/quota.ts";

const observedAt = 1_785_586_000_000;

function quotaLayer(
  execute: Parameters<typeof HttpClient.make>[0],
) {
  return CodexQuotaLive.pipe(
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(execute),
    )),
  );
}

const observeQuota = Effect.fn("test.codexQuota.observe")(function*() {
  const quota = yield* CodexQuota;
  return yield* quota.observe({
    accessToken: "provider-access-secret",
    providerAccountId: "provider-account-a",
    managedAccountId: "managed-a",
  });
});

describe("Effect Codex quota service", () => {
  it.effect("sends only the selected OAuth identity and retains only normalized quota", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(observedAt);
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly url: string;
        readonly authorization: string | undefined;
        readonly providerAccountId: string | undefined;
      }>>([]);
      const layer = quotaLayer((request) =>
        Ref.update(requests, (current) => [...current, {
          url: request.url,
          authorization: request.headers.authorization,
          providerAccountId: request.headers["chatgpt-account-id"],
        }]).pipe(
          Effect.as(HttpClientResponse.fromWeb(
            request,
            Response.json({
              plan_type: "pro",
              rate_limit: {
                primary_window: {
                  used_percent: 12,
                  limit_window_seconds: 18_000,
                  reset_at: 2_000_000_000,
                },
                secondary_window: {
                  used_percent: 34,
                  limit_window_seconds: 604_800,
                  reset_at: 2_000_100_000,
                },
              },
              ignored_secret_shape: { token: "must-not-survive" },
            }),
          )),
        ));
      const snapshot = yield* observeQuota().pipe(Effect.provide(layer));
      assert.deepStrictEqual(snapshot, {
        accountId: "managed-a",
        observedAt,
        shortWindow: { usedPercent: 12, resetsAt: 2_000_000_000_000 },
        weeklyWindow: { usedPercent: 34, resetsAt: 2_000_100_000_000 },
        stale: false,
        planType: "pro",
      });
      assert.notInclude(JSON.stringify(snapshot), "must-not-survive");
      assert.deepStrictEqual(yield* Ref.get(requests), [{
        url: "https://chatgpt.com/backend-api/wham/usage",
        authorization: "Bearer provider-access-secret",
        providerAccountId: "provider-account-a",
      }]);
    }));

  it.effect("keeps reauthentication, provider rejection, malformed data, and transport distinct", () =>
    Effect.gen(function*() {
      const responseCases = [
        { status: 401, expected: "needs_reauthentication", body: "private" },
        { status: 429, expected: "provider_rejected", body: "private" },
        { status: 503, expected: "provider_rejected", body: "private" },
        { status: 200, expected: "invalid_response", body: "not-json" },
      ];
      for (const candidate of responseCases) {
        const layer = quotaLayer((request) => Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(candidate.body, { status: candidate.status }),
          ),
        ));
        const failure = yield* Effect.flip(
          observeQuota().pipe(Effect.provide(layer)),
        );
        assert.instanceOf(failure, CodexQuotaError);
        assert.strictEqual(failure.code, candidate.expected);
        assert.strictEqual(failure.status, candidate.status);
        assert.notInclude(String(failure), candidate.body);
      }

      const transportLayer = quotaLayer((request) => Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "private transport detail",
          }),
        }),
      ));
      const transport = yield* Effect.flip(
        observeQuota().pipe(Effect.provide(transportLayer)),
      );
      assert.instanceOf(transport, CodexQuotaError);
      assert.strictEqual(transport.code, "provider_unavailable");
      assert.strictEqual(transport.status, null);
      assert.notInclude(String(transport), "private transport detail");
    }));

  it.effect("rejects decoded usage that cannot be attributed to the managed account", () =>
    Effect.gen(function*() {
      const layer = quotaLayer((request) => Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ rate_limit: {} }),
        ),
      ));
      const failure = yield* Effect.flip(
        observeQuota().pipe(Effect.provide(layer)),
      );
      assert.instanceOf(failure, CodexQuotaError);
      assert.strictEqual(failure.code, "invalid_response");
      assert.strictEqual(failure.status, 200);
    }));

  it.effect("interrupts a stalled provider request on the bounded Effect deadline", () =>
    Effect.gen(function*() {
      const layer = quotaLayer(() => Effect.never);
      const fiber = yield* Effect.forkChild(
        observeQuota().pipe(Effect.provide(layer)),
      );
      yield* TestClock.adjust(5_001);
      const failure = yield* Effect.flip(Fiber.join(fiber));
      assert.instanceOf(failure, CodexQuotaError);
      assert.strictEqual(failure.code, "provider_unavailable");
      assert.strictEqual(failure.status, null);
    }));
});
