import {
  AccountDirectory,
  AdminAuthenticator,
  AuthenticationError,
  ClientAuthenticator,
  CredentialUnavailableError,
  GatewayTelemetry,
  OAuthClient,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionCredential,
  TransportError,
  UpstreamTransport,
  UsageProbe,
  accountAdminLayer,
  makeCodexUsageProbe,
  makeHttpClientCodexControlTransport,
  makeOpenAiOAuthClient,
  secureCompare,
  subscriptionRouterLayer
} from "@akua-dev/codex-router-codex"
import {
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  type AccountId
} from "@akua-dev/codex-router-core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import { Crypto, Effect, Layer, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { BunRuntimeConfig, ConfiguredAccount } from "./config.ts"
import { bunMaintenanceLayer } from "./maintenance.ts"
import { sqliteSubscriptionAccountStoreLayer } from "./sqlite-account-store.ts"

const bearerToken = (request: Request): string | undefined => {
  const dedicated = request.headers.get("x-ai-router-token")?.trim()
  if (dedicated !== undefined && dedicated.length > 0) {
    return dedicated
  }
  const authorization = request.headers.get("authorization")?.trim()
  if (authorization?.toLowerCase().startsWith("bearer ") === true) {
    return authorization.slice(7).trim()
  }
  return undefined
}

export const bunClientAuthenticatorLayer = (config: BunRuntimeConfig) =>
  Layer.effect(
    ClientAuthenticator,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      return ClientAuthenticator.of({
        authenticate: (request) => {
          const actual = bearerToken(request)
          if (actual === undefined) {
            return Effect.succeed(false)
          }
          return secureCompare(actual, Redacted.value(config.clientToken)).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError(
              () =>
                new AuthenticationError({
                  message: "Client authentication could not be verified"
                })
            )
          )
        }
      })
    })
  )

export const bunAdminAuthenticatorLayer = (config: BunRuntimeConfig) =>
  Layer.effect(
    AdminAuthenticator,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      return AdminAuthenticator.of({
        authenticate: (request) => {
          const actual = request.headers.get("x-ai-router-admin-token")?.trim()
          if (actual === undefined || actual.length === 0) {
            return Effect.succeed(false)
          }
          return secureCompare(actual, Redacted.value(config.adminToken)).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError(
              () =>
                new AuthenticationError({
                  message: "Administrator authentication could not be verified"
                })
            )
          )
        }
      })
    })
  )

const accountCandidate = (account: ConfiguredAccount): Candidate =>
  Candidate.make({
    accountId: account.accountId,
    activeReservations: 0,
    requiresReauthentication: false,
    usage: UsageSnapshot.make({
      accountId: account.accountId,
      observedAt: account.observedAt,
      short: UsageWindow.make({
        resetAt: account.shortResetAt,
        usedPercent: account.shortUsedPercent
      }),
      weekly: UsageWindow.make({
        resetAt: account.weeklyResetAt,
        usedPercent: account.weeklyUsedPercent
      })
    })
  })

const accountCredential = (account: ConfiguredAccount): SubscriptionCredential =>
  SubscriptionCredential.make({
    accessToken: account.accessToken,
    accountId: account.accountId,
    expiresAt: account.expiresAt,
    generation: 1,
    providerAccountId: account.providerAccountId,
    refreshToken: account.refreshToken
  })

const accountState = (account: ConfiguredAccount): SubscriptionAccountState => {
  const candidate = accountCandidate(account)
  return SubscriptionAccountState.make({
    accountId: account.accountId,
    credential: accountCredential(account),
    enabled: true,
    requiresReauthentication: false,
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage })
  })
}

export const bunAccountDirectoryLayer = (config: BunRuntimeConfig) =>
  Layer.succeed(
    AccountDirectory,
    AccountDirectory.of({
      candidates: Effect.succeed(config.accounts.map(accountCandidate)),
      credential: (accountId: AccountId) => {
        const account = config.accounts.find((configured) => configured.accountId === accountId)
        return account === undefined
          ? Effect.fail(
              new CredentialUnavailableError({
                message: "No credential exists for the selected opaque account"
              })
            )
          : Effect.succeed(accountCredential(account))
      }
    })
  )

export const bunUpstreamTransportLayer = Layer.succeed(
  UpstreamTransport,
  UpstreamTransport.of({
    execute: (request) =>
      Effect.tryPromise({
        try: () => fetch(request),
        catch: () =>
          new TransportError({
            message: "The upstream request did not complete"
          })
      })
  })
)

export const bunGatewayTelemetryLayer = Layer.succeed(
  GatewayTelemetry,
  GatewayTelemetry.of({
    decision: (event) =>
      Effect.logInfo("codex-router selected account").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          reason: event.reason,
          sessionBound: String(event.sessionKey.valueOrUndefined !== undefined)
        })
      ),
    bookkeepingFailure: (event) =>
      Effect.logWarning("codex-router bookkeeping failure").pipe(
        Effect.annotateLogs({
          accountId: event.accountId,
          operation: event.operation
        })
      )
  })
)

export interface BunRuntimeLayerOptions {
  readonly maintenance?: boolean
}

export const bunRuntimeLayer = (config: BunRuntimeConfig, options: BunRuntimeLayerOptions = {}) => {
  const storage = sqliteSubscriptionAccountStoreLayer(config.databasePath, defaultRoutingConfig)
  const seed = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* SubscriptionAccountStore
      yield* store.seedIfAbsent(config.accounts.map(accountState))
    })
  ).pipe(Layer.provide(storage))
  const initializedStorage = Layer.merge(storage, seed)
  const controlServices = Layer.merge(
    Layer.effect(
      OAuthClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        makeOpenAiOAuthClient({
          transport: makeHttpClientCodexControlTransport(client)
        })
      )
    ),
    Layer.effect(
      UsageProbe,
      Effect.map(HttpClient.HttpClient, (client) =>
        makeCodexUsageProbe({
          transport: makeHttpClientCodexControlTransport(client)
        })
      )
    )
  ).pipe(Layer.provide(BunHttpClient.layer))
  const authenticators = Layer.merge(
    bunAdminAuthenticatorLayer(config),
    bunClientAuthenticatorLayer(config)
  ).pipe(Layer.provide(BunCrypto.layer))
  const dependencies = Layer.mergeAll(
    initializedStorage,
    BunCrypto.layer,
    BunHttpClient.layer,
    authenticators,
    bunUpstreamTransportLayer,
    bunGatewayTelemetryLayer,
    controlServices
  )
  const application = Layer.mergeAll(
    dependencies,
    accountAdminLayer.pipe(Layer.provide(dependencies)),
    subscriptionRouterLayer.pipe(Layer.provide(dependencies))
  )
  return options.maintenance === false
    ? application
    : Layer.merge(application, bunMaintenanceLayer.pipe(Layer.provide(application)))
}
