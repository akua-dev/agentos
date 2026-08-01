import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  Ref,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  CodexOAuthError,
  makeOpenAICodexOAuthClient,
} from "../src/codex-oauth-effect.ts";

function httpLayer(
  execute: Parameters<typeof HttpClient.make>[0],
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(execute),
  );
}

describe("Effect OpenAI Codex OAuth boundary", () => {
  it.effect("runs device-code login through scoped Effect HTTP", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const notifications = yield* Ref.make<ReadonlyArray<{
        readonly userCode: string;
        readonly verificationUri: string;
      }>>([]);
      const layer = httpLayer((request) =>
        Effect.gen(function*() {
          const url = Option.getOrUndefined(
            HttpClientRequest.toUrl(request),
          )?.toString() ?? "invalid";
          yield* Ref.update(requests, (current) => [...current, url]);
          const body = url.endsWith("/api/accounts/deviceauth/usercode")
            ? {
                device_auth_id: "device-auth-a",
                user_code: "ABCD-EFGH",
                interval: 0,
              }
            : url.endsWith("/api/accounts/deviceauth/token")
              ? {
                  authorization_code: "authorization-code-a",
                  code_verifier: "verifier-a",
                }
              : {
                  access_token: "access-token-a",
                  refresh_token: "refresh-token-a",
                  expires_in: 3_600,
                };
          return HttpClientResponse.fromWeb(request, Response.json(body));
        })
      );
      const credentials = yield* Effect.gen(function*() {
        const client = yield* makeOpenAICodexOAuthClient({
          authBaseUrl: "https://auth.openai.test",
        });
        return yield* client.login((info) =>
          Ref.update(notifications, (current) => [
            ...current,
            {
              userCode: info.userCode,
              verificationUri: info.verificationUri,
            },
          ])
        );
      }).pipe(Effect.provide(layer));

      assert.strictEqual(credentials.access, "access-token-a");
      assert.strictEqual(credentials.refresh, "refresh-token-a");
      assert.deepStrictEqual(yield* Ref.get(notifications), [{
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.test/codex/device",
      }]);
      assert.deepStrictEqual(yield* Ref.get(requests), [
        "https://auth.openai.test/api/accounts/deviceauth/usercode",
        "https://auth.openai.test/api/accounts/deviceauth/token",
        "https://auth.openai.test/oauth/token",
      ]);
    }));

  it.effect("keeps invalid grants typed and foreign response bodies private", () =>
    Effect.gen(function*() {
      const layer = httpLayer((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          Response.json(
            { error: "invalid_grant", detail: "provider-secret" },
            { status: 400 },
          ),
        ))
      );
      const failure = yield* Effect.gen(function*() {
        const client = yield* makeOpenAICodexOAuthClient({
          authBaseUrl: "https://auth.openai.test",
        });
        return yield* client.refresh("refresh-secret");
      }).pipe(Effect.provide(layer), Effect.flip);

      assert.instanceOf(failure, CodexOAuthError);
      assert.strictEqual(failure.code, "invalid_grant");
      assert.notInclude(String(failure), "provider-secret");
      assert.notInclude(String(failure), "refresh-secret");
    }));
});
