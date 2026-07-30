import {
  AccountAdminSummary,
  DeviceAuthorizationReady,
  type DeviceAuthorizationResult,
  type OAuthClientShape,
  type SubscriptionCredential
} from "@akua-dev/codex-router-codex"
import type { AccountId } from "@akua-dev/codex-router-core"
import { Duration, Effect, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"

export class RemoteAdminConfigurationError extends Schema.TaggedErrorClass<RemoteAdminConfigurationError>()(
  "RemoteAdminConfigurationError",
  {
    message: Schema.String
  }
) {}

export class RemoteAdminTransportError extends Schema.TaggedErrorClass<RemoteAdminTransportError>()(
  "RemoteAdminTransportError",
  {
    message: Schema.String
  }
) {}

export type RemoteAdminError = RemoteAdminConfigurationError | RemoteAdminTransportError

export interface RemoteAccountAdminClient {
  readonly list: () => Effect.Effect<ReadonlyArray<AccountAdminSummary>, RemoteAdminTransportError>
  readonly putCredential: (
    accountId: AccountId,
    credential: SubscriptionCredential
  ) => Effect.Effect<AccountAdminSummary, RemoteAdminTransportError>
  readonly remove: (accountId: AccountId) => Effect.Effect<boolean, RemoteAdminTransportError>
  readonly setEnabled: (
    accountId: AccountId,
    enabled: boolean
  ) => Effect.Effect<AccountAdminSummary, RemoteAdminTransportError>
}

const AccountListResponse = Schema.Struct({
  accounts: Schema.Array(AccountAdminSummary)
})

const decodeAccount = Schema.decodeUnknownEffect(AccountAdminSummary)
const decodeAccountList = Schema.decodeUnknownEffect(AccountListResponse)

const configurationFailure = () =>
  new RemoteAdminConfigurationError({
    message: "The remote administration endpoint must use HTTPS or a loopback address"
  })

const transportFailure = () =>
  new RemoteAdminTransportError({
    message: "The remote account administration request failed"
  })

const parseRemoteUrl = (value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: configurationFailure
  }).pipe(
    Effect.filterOrFail((url) => {
      const hostname = url.hostname.toLowerCase()
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"))
      )
    }, configurationFailure)
  )

const responseJson = Effect.fn("RemoteAccountAdmin.responseJson")(function* (
  response: HttpClientResponse.HttpClientResponse
) {
  if (response.status < 200 || response.status >= 300) {
    return yield* transportFailure()
  }
  return yield* response.json.pipe(Effect.mapError(transportFailure))
})

export const makeRemoteAccountAdminClient = Effect.fn("makeRemoteAccountAdminClient")(
  function* (options: {
    readonly adminToken: Redacted.Redacted<string>
    readonly baseUrl: string
    readonly client: HttpClient.HttpClient
  }) {
    const baseUrl = yield* parseRemoteUrl(options.baseUrl)
    const client = options.client

    const execute = Effect.fn("RemoteAccountAdmin.execute")(function* (
      path: string,
      init?: RequestInit
    ) {
      const request = new Request(new URL(path, baseUrl).toString(), {
        ...init,
        headers: {
          ...init?.headers,
          "x-ai-router-admin-token": Redacted.value(options.adminToken)
        }
      })
      return yield* client
        .execute(HttpClientRequest.fromWeb(request))
        .pipe(Effect.mapError(transportFailure))
    })

    return {
      list: Effect.fn("RemoteAccountAdmin.list")(function* () {
        const response = yield* execute("/admin/accounts")
        const body = yield* responseJson(response)
        const decoded = yield* decodeAccountList(body).pipe(Effect.mapError(transportFailure))
        return decoded.accounts
      }),
      putCredential: Effect.fn("RemoteAccountAdmin.putCredential")(
        function* (accountId, credential) {
          const response = yield* execute(`/admin/accounts/${accountId}/credential`, {
            body: JSON.stringify({
              accessToken: Redacted.value(credential.accessToken),
              expiresAt: credential.expiresAt,
              refreshToken: Redacted.value(credential.refreshToken)
            }),
            headers: { "content-type": "application/json" },
            method: "PUT"
          })
          const body = yield* responseJson(response)
          return yield* decodeAccount(body).pipe(Effect.mapError(transportFailure))
        }
      ),
      remove: Effect.fn("RemoteAccountAdmin.remove")(function* (accountId) {
        const response = yield* execute(`/admin/accounts/${accountId}`, {
          method: "DELETE"
        })
        if (response.status === 204) {
          return true
        }
        if (response.status === 404) {
          return false
        }
        return yield* transportFailure()
      }),
      setEnabled: Effect.fn("RemoteAccountAdmin.setEnabled")(function* (accountId, enabled) {
        const response = yield* execute(`/admin/accounts/${accountId}/enabled`, {
          body: JSON.stringify({ enabled }),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
        const body = yield* responseJson(response)
        return yield* decodeAccount(body).pipe(Effect.mapError(transportFailure))
      })
    } satisfies RemoteAccountAdminClient
  }
)

const isReady = (result: DeviceAuthorizationResult): result is DeviceAuthorizationReady =>
  result._tag === "DeviceAuthorizationReady"

const pollSchedule = Schedule.identity<DeviceAuthorizationResult>().pipe(
  Schedule.addDelay(({ input }) =>
    Effect.succeed(isReady(input) ? Duration.zero : Duration.seconds(input.retryAfterSeconds))
  )
)

export const runRemoteDeviceLogin = Effect.fn("runRemoteDeviceLogin")(function* (options: {
  readonly accountId: AccountId
  readonly admin: RemoteAccountAdminClient
  readonly oauth: OAuthClientShape
  readonly onInstruction: (message: string) => Effect.Effect<void>
}) {
  const device = yield* options.oauth.startDeviceAuthorization()
  yield* options.onInstruction(`Open ${device.verificationUri} and enter code ${device.userCode}`)
  const poll = Effect.suspend(() =>
    options.oauth.pollDeviceAuthorization(device, options.accountId)
  )
  const authorization = yield* Effect.sleep(Duration.seconds(device.intervalSeconds)).pipe(
    Effect.andThen(poll),
    Effect.repeat({
      schedule: pollSchedule,
      until: isReady
    })
  )
  return yield* options.admin.putCredential(options.accountId, authorization.credential)
})
