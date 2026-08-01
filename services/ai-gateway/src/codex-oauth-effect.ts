import type {
  OAuthCredentials,
  OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const MAXIMUM_RESPONSE_BYTES = 64 * 1_024;

const NonEmptyString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
);
const DeviceAuthorizationResponse = Schema.Struct({
  device_auth_id: NonEmptyString,
  user_code: NonEmptyString,
  interval: Schema.Union([Schema.Number, Schema.String]),
});
const DeviceTokenResponse = Schema.Struct({
  authorization_code: NonEmptyString,
  code_verifier: NonEmptyString,
});
const TokenResponse = Schema.Struct({
  access_token: NonEmptyString,
  refresh_token: NonEmptyString,
  expires_in: Schema.Number,
});
const OAuthErrorResponse = Schema.Struct({
  error: Schema.Union([
    Schema.String,
    Schema.Struct({ code: Schema.String }),
  ]),
});

const CodexOAuthErrorCode = Schema.Literals([
  "invalid_grant",
  "oauth_unavailable",
  "unsupported_flow",
]);

export class CodexOAuthError extends Schema.TaggedErrorClass<CodexOAuthError>()(
  "CodexOAuthError",
  { code: CodexOAuthErrorCode },
) {}

export interface CodexOAuthRefreshClient {
  readonly refresh: (
    refreshToken: string,
  ) => Effect.Effect<OAuthCredentials, CodexOAuthError>;
}

export interface CodexOAuthClient extends CodexOAuthRefreshClient {
  readonly login: (
    onDeviceCode: (info: OAuthDeviceCodeInfo) => Effect.Effect<void>,
  ) => Effect.Effect<OAuthCredentials, CodexOAuthError>;
}

export function makeOpenAICodexOAuthClient(options: {
  readonly authBaseUrl?: string;
} = {}) {
  return Effect.gen(function*() {
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const endpoints = yield* makeEndpoints(
      options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL,
    );

    const execute = Effect.fn("agentos.aiGateway.codexOAuth.execute")(
      function*(request: HttpClientRequest.HttpClientRequest) {
        return yield* Effect.scoped(Effect.gen(function*() {
          const response = yield* http.execute(request).pipe(
            Effect.mapError(() => oauthError("oauth_unavailable")),
          );
          const source = yield* readBoundedResponse(response);
          return { response, source };
        }));
      },
    );

    const exchange = Effect.fn("agentos.aiGateway.codexOAuth.exchange")(
      function*(authorizationCode: string, verifier: string) {
        const request = HttpClientRequest.post(endpoints.token).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code: authorizationCode,
            code_verifier: verifier,
            redirect_uri: endpoints.deviceRedirect,
          }),
        );
        const { response, source } = yield* execute(request);
        return yield* decodeTokenResponse(response.status, source);
      },
    );

    const poll = Effect.fn("agentos.aiGateway.codexOAuth.poll")(
      function poll(
        deviceAuthId: string,
        userCode: string,
        intervalMillis: number,
        deadline: number,
      ): Effect.Effect<
        { readonly authorizationCode: string; readonly verifier: string },
        CodexOAuthError
      > {
        return Effect.gen(function*() {
          const currentTime = yield* Clock.currentTimeMillis;
          if (currentTime >= deadline) {
            return yield* oauthError("oauth_unavailable");
          }
          yield* Effect.sleep(Duration.millis(intervalMillis));
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(endpoints.deviceToken),
            {
              device_auth_id: deviceAuthId,
              user_code: userCode,
            },
          ).pipe(Effect.mapError(() => oauthError("oauth_unavailable")));
          const { response, source } = yield* execute(request);
          if (response.status >= 200 && response.status < 300) {
            const token = yield* decodeJson(DeviceTokenResponse, source);
            return {
              authorizationCode: token.authorization_code,
              verifier: token.code_verifier,
            };
          }
          if (response.status === 403 || response.status === 404) {
            return yield* poll(
              deviceAuthId,
              userCode,
              intervalMillis,
              deadline,
            );
          }
          const errorCode = yield* decodeOAuthErrorCode(source);
          if (errorCode === "deviceauth_authorization_pending") {
            return yield* poll(
              deviceAuthId,
              userCode,
              intervalMillis,
              deadline,
            );
          }
          if (errorCode === "slow_down") {
            return yield* poll(
              deviceAuthId,
              userCode,
              Math.min(intervalMillis + 5_000, 60_000),
              deadline,
            );
          }
          return yield* oauthError("oauth_unavailable");
        });
      },
    );

    const login: CodexOAuthClient["login"] = (onDeviceCode) =>
      Effect.gen(function*() {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(endpoints.deviceUserCode),
          { client_id: CLIENT_ID },
        ).pipe(Effect.mapError(() => oauthError("oauth_unavailable")));
        const { response, source } = yield* execute(request);
        if (response.status < 200 || response.status >= 300) {
          return yield* oauthError("oauth_unavailable");
        }
        const device = yield* decodeJson(
          DeviceAuthorizationResponse,
          source,
        );
        const intervalSeconds = typeof device.interval === "string"
          ? Number(device.interval.trim())
          : device.interval;
        if (
          !Number.isFinite(intervalSeconds) ||
          intervalSeconds < 0 ||
          intervalSeconds > 60
        ) {
          return yield* oauthError("oauth_unavailable");
        }
        yield* onDeviceCode({
          userCode: device.user_code,
          verificationUri: endpoints.deviceVerification,
          intervalSeconds,
          expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
        });
        const startedAt = yield* Clock.currentTimeMillis;
        const code = yield* poll(
          device.device_auth_id,
          device.user_code,
          intervalSeconds * 1_000,
          startedAt + DEVICE_CODE_TIMEOUT_SECONDS * 1_000,
        );
        return yield* exchange(code.authorizationCode, code.verifier);
      });

    const refresh: CodexOAuthClient["refresh"] = (refreshToken) =>
      Effect.gen(function*() {
        const request = HttpClientRequest.post(endpoints.token).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
          }),
        );
        const { response, source } = yield* execute(request);
        if (response.status < 200 || response.status >= 300) {
          const code = yield* decodeOAuthErrorCode(source);
          return yield* oauthError(
            code === "invalid_grant" || code === "token_revoked"
              ? "invalid_grant"
              : "oauth_unavailable",
          );
        }
        return yield* decodeTokenResponse(response.status, source);
      });

    return { login, refresh } satisfies CodexOAuthClient;
  });
}

interface OAuthEndpoints {
  readonly deviceRedirect: string;
  readonly deviceToken: string;
  readonly deviceUserCode: string;
  readonly deviceVerification: string;
  readonly token: string;
}

function makeEndpoints(authBaseUrl: string) {
  return Effect.try({
    try: (): OAuthEndpoints => {
      const base = new URL(authBaseUrl);
      return {
        deviceRedirect: new URL("/deviceauth/callback", base).toString(),
        deviceToken: new URL(
          "/api/accounts/deviceauth/token",
          base,
        ).toString(),
        deviceUserCode: new URL(
          "/api/accounts/deviceauth/usercode",
          base,
        ).toString(),
        deviceVerification: new URL("/codex/device", base).toString(),
        token: new URL("/oauth/token", base).toString(),
      };
    },
    catch: () => oauthError("oauth_unavailable"),
  });
}

function decodeTokenResponse(status: number, source: string) {
  if (status < 200 || status >= 300) {
    return Effect.fail(oauthError("oauth_unavailable"));
  }
  return Effect.gen(function*() {
    const body = yield* decodeJson(TokenResponse, source);
    const now = yield* Clock.currentTimeMillis;
    const expires = now + body.expires_in * 1_000;
    if (
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      !Number.isSafeInteger(expires)
    ) {
      return yield* oauthError("oauth_unavailable");
    }
    return {
      access: body.access_token,
      refresh: body.refresh_token,
      expires,
    } satisfies OAuthCredentials;
  });
}

function decodeJson<S extends Schema.Top>(schema: S, source: string) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source).pipe(
    Effect.mapError(() => oauthError("oauth_unavailable")),
  );
}

function decodeOAuthErrorCode(source: string) {
  return decodeJson(OAuthErrorResponse, source).pipe(
    Effect.option,
    Effect.map(Option.map((body) =>
      typeof body.error === "string" ? body.error : body.error.code
    )),
    Effect.map(Option.getOrUndefined),
  );
}

function readBoundedResponse(response: HttpClientResponse.HttpClientResponse) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAXIMUM_RESPONSE_BYTES
  ) {
    return Effect.fail(oauthError("oauth_unavailable"));
  }
  return response.stream.pipe(
    Stream.runFoldEffect(
      emptyResponseBody,
      (state, chunk) => {
        const length = state.length + chunk.byteLength;
        return length > MAXIMUM_RESPONSE_BYTES
          ? Effect.fail(oauthError("oauth_unavailable"))
          : Effect.succeed({
              chunks: [...state.chunks, chunk],
              length,
            });
      },
    ),
    Effect.map(({ chunks, length }) => {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }),
    Effect.mapError(() => oauthError("oauth_unavailable")),
  );
}

function emptyResponseBody(): {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
} {
  return { chunks: [], length: 0 };
}

function oauthError(code: CodexOAuthError["code"]) {
  return CodexOAuthError.make({ code });
}
