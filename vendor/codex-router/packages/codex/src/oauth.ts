import { AccountId, type AccountId as AccountIdType } from "@akua-dev/codex-router-core"
import { Clock, Context, Effect, Redacted, Schema } from "effect"
import type { HttpClientResponse } from "effect/unstable/http"
import {
  SubscriptionCredential,
  extractProviderAccountId,
  type CredentialGeneration
} from "./credentials.ts"
import type { CodexControlTransportShape } from "./control-transport.ts"

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
const authBaseUrl = "https://auth.openai.com"
const deviceVerificationUri = `${authBaseUrl}/codex/device`
const deviceRedirectUri = `${authBaseUrl}/deviceauth/callback`
const deviceTimeoutMs = 15 * 60 * 1_000

export class DeviceAuthorization extends Schema.Class<DeviceAuthorization>("DeviceAuthorization")({
  deviceAuthId: Schema.Redacted(Schema.String),
  expiresAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  intervalSeconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  userCode: Schema.String.check(Schema.isNonEmpty()),
  verificationUri: Schema.String.check(Schema.isNonEmpty())
}) {}

export class DeviceAuthorizationPending extends Schema.TaggedClass<DeviceAuthorizationPending>()(
  "DeviceAuthorizationPending",
  {
    retryAfterSeconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  }
) {}

export class DeviceAuthorizationReady extends Schema.TaggedClass<DeviceAuthorizationReady>()(
  "DeviceAuthorizationReady",
  {
    credential: SubscriptionCredential
  }
) {}

export type DeviceAuthorizationResult = DeviceAuthorizationPending | DeviceAuthorizationReady

export class OAuthTransportError extends Schema.TaggedErrorClass<OAuthTransportError>()(
  "OAuthTransportError",
  {
    message: Schema.String
  }
) {}

export class OAuthPayloadError extends Schema.TaggedErrorClass<OAuthPayloadError>()(
  "OAuthPayloadError",
  {
    message: Schema.String
  }
) {}

export class OAuthInvalidGrantError extends Schema.TaggedErrorClass<OAuthInvalidGrantError>()(
  "OAuthInvalidGrantError",
  {
    message: Schema.String
  }
) {}

export class ProviderIdentityChangedError extends Schema.TaggedErrorClass<ProviderIdentityChangedError>()(
  "ProviderIdentityChangedError",
  {
    message: Schema.String
  }
) {}

export type OAuthClientError =
  OAuthTransportError | OAuthPayloadError | OAuthInvalidGrantError | ProviderIdentityChangedError

export interface OAuthClientShape {
  readonly startDeviceAuthorization: () => Effect.Effect<
    DeviceAuthorization,
    OAuthTransportError | OAuthPayloadError
  >
  readonly pollDeviceAuthorization: (
    device: DeviceAuthorization,
    accountId?: AccountIdType
  ) => Effect.Effect<DeviceAuthorizationResult, OAuthClientError>
  readonly refresh: (
    credential: SubscriptionCredential
  ) => Effect.Effect<SubscriptionCredential, OAuthClientError>
}

export class OAuthClient extends Context.Service<OAuthClient, OAuthClientShape>()(
  "@akua-dev/codex-router/OAuthClient"
) {}

const DeviceStartResponse = Schema.Struct({
  device_auth_id: Schema.String.check(Schema.isNonEmpty()),
  interval: Schema.Union([Schema.Number, Schema.String]),
  user_code: Schema.String.check(Schema.isNonEmpty())
})

const DevicePollResponse = Schema.Struct({
  authorization_code: Schema.String.check(Schema.isNonEmpty()),
  code_verifier: Schema.String.check(Schema.isNonEmpty())
})

const DevicePollErrorResponse = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        code: Schema.optionalKey(Schema.String)
      })
    ])
  )
})
type DevicePollErrorResponse = typeof DevicePollErrorResponse.Type

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isNonEmpty()),
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty()))
})

const OAuthErrorResponse = Schema.Struct({
  error: Schema.optionalKey(Schema.String)
})

const decodeDeviceStart = Schema.decodeUnknownEffect(DeviceStartResponse)
const decodeDevicePoll = Schema.decodeUnknownEffect(DevicePollResponse)
const decodeDevicePollError = Schema.decodeUnknownEffect(DevicePollErrorResponse)
const decodeToken = Schema.decodeUnknownEffect(TokenResponse)
const decodeOAuthError = Schema.decodeUnknownEffect(OAuthErrorResponse)

const payloadFailure = () =>
  new OAuthPayloadError({
    message: "The OpenAI OAuth response has an unsupported shape"
  })

const transportFailure = () =>
  new OAuthTransportError({
    message: "The OpenAI OAuth request did not complete"
  })

const readJson = Effect.fn("OAuthClient.readJson")(
  (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.mapError(payloadFailure))
)

const execute = Effect.fn("OAuthClient.execute")(function* (
  transport: CodexControlTransportShape,
  request: Request
) {
  return yield* transport.execute(request).pipe(Effect.mapError(transportFailure))
})

const parseInterval = (value: number | string): Effect.Effect<number, OAuthPayloadError> =>
  Effect.try({
    try: () => {
      const interval = typeof value === "string" ? Number(value.trim()) : value
      if (!Number.isFinite(interval) || interval < 0) {
        throw payloadFailure()
      }
      return Math.max(1, interval)
    },
    catch: payloadFailure
  })

const deviceErrorCode = (value: DevicePollErrorResponse["error"]): string | undefined => {
  if (typeof value === "string") {
    return value
  }
  return value?.code
}

const decodeTokenResponse = Effect.fn("OAuthClient.decodeTokenResponse")(function* (
  response: HttpClientResponse.HttpClientResponse
) {
  const body = yield* readJson(response)
  const token = yield* decodeToken(body).pipe(Effect.mapError(payloadFailure))
  if (!Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    return yield* payloadFailure()
  }
  return token
})

const requestToken = Effect.fn("OAuthClient.requestToken")(function* (
  transport: CodexControlTransportShape,
  form: URLSearchParams
) {
  const response = yield* execute(
    transport,
    new Request(`${authBaseUrl}/oauth/token`, {
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST"
    })
  )
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 400) {
      const decoded = yield* Effect.option(
        readJson(response).pipe(Effect.flatMap(decodeOAuthError), Effect.mapError(payloadFailure))
      )
      if (decoded._tag === "Some" && decoded.value.error === "invalid_grant") {
        return yield* new OAuthInvalidGrantError({
          message: "The OpenAI OAuth grant is no longer valid"
        })
      }
    }
    return yield* transportFailure()
  }
  return yield* decodeTokenResponse(response)
})

const makeCredential = Effect.fn("OAuthClient.makeCredential")(function* (
  input: {
    readonly accessToken: string
    readonly accountId: AccountIdType
    readonly expiresAt: number
    readonly generation: CredentialGeneration
    readonly refreshToken: string
  },
  expectedProviderAccountId?: Redacted.Redacted<string>
) {
  const providerAccountId = yield* extractProviderAccountId(input.accessToken).pipe(
    Effect.mapError(payloadFailure)
  )
  if (
    expectedProviderAccountId !== undefined &&
    Redacted.value(providerAccountId) !== Redacted.value(expectedProviderAccountId)
  ) {
    return yield* new ProviderIdentityChangedError({
      message: "The refreshed credential resolved to a different provider account"
    })
  }
  return SubscriptionCredential.make({
    accessToken: Redacted.make(input.accessToken),
    accountId: AccountId.make(input.accountId),
    expiresAt: input.expiresAt,
    generation: input.generation,
    providerAccountId,
    refreshToken: Redacted.make(input.refreshToken)
  })
})

export const makeOpenAiOAuthClient = (options: {
  readonly clock?: () => number
  readonly transport: CodexControlTransportShape
}): OAuthClientShape => {
  const currentTimeMillis =
    options.clock === undefined ? Clock.currentTimeMillis : Effect.sync(options.clock)

  return OAuthClient.of({
    startDeviceAuthorization: Effect.fn("OAuthClient.startDeviceAuthorization")(function* () {
      const response = yield* execute(
        options.transport,
        new Request(`${authBaseUrl}/api/accounts/deviceauth/usercode`, {
          body: JSON.stringify({ client_id: clientId }),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* transportFailure()
      }
      const body = yield* readJson(response)
      const decoded = yield* decodeDeviceStart(body).pipe(Effect.mapError(payloadFailure))
      const intervalSeconds = yield* parseInterval(decoded.interval)
      return DeviceAuthorization.make({
        deviceAuthId: Redacted.make(decoded.device_auth_id),
        expiresAt: (yield* currentTimeMillis) + deviceTimeoutMs,
        intervalSeconds,
        userCode: decoded.user_code,
        verificationUri: deviceVerificationUri
      })
    }),

    pollDeviceAuthorization: Effect.fn("OAuthClient.pollDeviceAuthorization")(
      function* (device, accountId) {
        if ((yield* currentTimeMillis) >= device.expiresAt) {
          return yield* new OAuthPayloadError({
            message: "The OpenAI device authorization expired"
          })
        }
        const response = yield* execute(
          options.transport,
          new Request(`${authBaseUrl}/api/accounts/deviceauth/token`, {
            body: JSON.stringify({
              device_auth_id: Redacted.value(device.deviceAuthId),
              user_code: device.userCode
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
          })
        )
        if (response.status === 403 || response.status === 404) {
          return DeviceAuthorizationPending.make({
            retryAfterSeconds: device.intervalSeconds
          })
        }
        if (response.status < 200 || response.status >= 300) {
          const decoded = yield* Effect.option(
            readJson(response).pipe(
              Effect.flatMap(decodeDevicePollError),
              Effect.mapError(payloadFailure)
            )
          )
          if (decoded._tag === "Some") {
            const code = deviceErrorCode(decoded.value.error)
            if (code === "deviceauth_authorization_pending") {
              return DeviceAuthorizationPending.make({
                retryAfterSeconds: device.intervalSeconds
              })
            }
            if (code === "slow_down") {
              return DeviceAuthorizationPending.make({
                retryAfterSeconds: device.intervalSeconds + 5
              })
            }
          }
          return yield* transportFailure()
        }
        if (accountId === undefined) {
          return yield* payloadFailure()
        }
        const body = yield* readJson(response)
        const code = yield* decodeDevicePoll(body).pipe(Effect.mapError(payloadFailure))
        const token = yield* requestToken(
          options.transport,
          new URLSearchParams({
            client_id: clientId,
            code: code.authorization_code,
            code_verifier: code.code_verifier,
            grant_type: "authorization_code",
            redirect_uri: deviceRedirectUri
          })
        )
        if (token.refresh_token === undefined) {
          return yield* payloadFailure()
        }
        const credential = yield* makeCredential({
          accessToken: token.access_token,
          accountId,
          expiresAt: (yield* currentTimeMillis) + token.expires_in * 1_000,
          generation: 1,
          refreshToken: token.refresh_token
        })
        return DeviceAuthorizationReady.make({ credential })
      }
    ),

    refresh: Effect.fn("OAuthClient.refresh")(function* (credential) {
      const token = yield* requestToken(
        options.transport,
        new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: Redacted.value(credential.refreshToken)
        })
      )
      return yield* makeCredential(
        {
          accessToken: token.access_token,
          accountId: credential.accountId,
          expiresAt: (yield* currentTimeMillis) + token.expires_in * 1_000,
          generation: credential.generation + 1,
          refreshToken: token.refresh_token ?? Redacted.value(credential.refreshToken)
        },
        credential.providerAccountId
      )
    })
  })
}
