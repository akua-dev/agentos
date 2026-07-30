import { AccountId, type AccountId as AccountIdType } from "@akua-dev/codex-router-core"
import { Clock, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { HttpEffect } from "effect/unstable/http"
import { SubscriptionAccountStore, type SubscriptionAccountState } from "./account-store.ts"
import type { SubscriptionCredential } from "./credentials.ts"
import {
  SubscriptionCredential as SubscriptionCredentialModel,
  extractProviderAccountId
} from "./credentials.ts"
import { AdminAuthenticator } from "./services.ts"
import { makeRawWebHandler } from "./http-application.ts"

export class AccountAdminSummary extends Schema.Class<AccountAdminSummary>("AccountAdminSummary")({
  accountId: AccountId,
  enabled: Schema.Boolean,
  expiresAt: Schema.optionalKey(Schema.Number),
  generation: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  requiresReauthentication: Schema.Boolean,
  usageObservedAt: Schema.optionalKey(Schema.Number)
}) {}

export class AccountAdminError extends Schema.TaggedErrorClass<AccountAdminError>()(
  "AccountAdminError",
  {
    message: Schema.String
  }
) {}

export class ProviderIdentityConflictError extends Schema.TaggedErrorClass<ProviderIdentityConflictError>()(
  "ProviderIdentityConflictError",
  {
    message: Schema.String
  }
) {}

export type AccountAdminFailure = AccountAdminError | ProviderIdentityConflictError

export interface AccountAdminShape {
  readonly list: () => Effect.Effect<ReadonlyArray<AccountAdminSummary>, AccountAdminError>
  readonly putCredential: (
    accountId: AccountIdType,
    credential: SubscriptionCredential,
    now: number
  ) => Effect.Effect<AccountAdminSummary, AccountAdminFailure>
  readonly setEnabled: (
    accountId: AccountIdType,
    enabled: boolean,
    now: number
  ) => Effect.Effect<Option.Option<AccountAdminSummary>, AccountAdminError>
  readonly remove: (accountId: AccountIdType) => Effect.Effect<boolean, AccountAdminError>
}

export class AccountAdmin extends Context.Service<AccountAdmin, AccountAdminShape>()(
  "@akua-dev/codex-router/AccountAdmin"
) {}

const adminFailure = () =>
  new AccountAdminError({
    message: "Subscription account administration failed"
  })

const summary = (account: SubscriptionAccountState): AccountAdminSummary =>
  AccountAdminSummary.make({
    accountId: account.accountId,
    enabled: account.enabled,
    requiresReauthentication: account.requiresReauthentication,
    ...(account.credential === undefined
      ? {}
      : {
          expiresAt: account.credential.expiresAt,
          generation: account.credential.generation
        }),
    ...(account.usage === undefined ? {} : { usageObservedAt: account.usage.observedAt })
  })

export const makeAccountAdmin = Effect.fn("makeAccountAdmin")(function* () {
  const store = yield* SubscriptionAccountStore
  return AccountAdmin.of({
    list: Effect.fn("AccountAdmin.list")(function* () {
      const accounts = yield* store.list.pipe(Effect.mapError(adminFailure))
      return accounts.map(summary)
    }),
    putCredential: Effect.fn("AccountAdmin.putCredential")(function* (accountId, credential, now) {
      const replaced = yield* store
        .replaceCredential({ accountId, credential, now })
        .pipe(Effect.mapError(adminFailure))
      if (Option.isNone(replaced)) {
        return yield* new ProviderIdentityConflictError({
          message: "The authenticated provider identity does not match the managed account"
        })
      }
      return summary(replaced.value)
    }),
    remove: Effect.fn("AccountAdmin.remove")((accountId) =>
      store.remove(accountId).pipe(Effect.mapError(adminFailure))
    ),
    setEnabled: Effect.fn("AccountAdmin.setEnabled")((accountId, enabled, now) =>
      store
        .setEnabled(accountId, enabled, now)
        .pipe(Effect.map(Option.map(summary)), Effect.mapError(adminFailure))
    )
  })
})

export const accountAdminLayer = Layer.effect(AccountAdmin, makeAccountAdmin())

const ManagedAccountId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
)

const CredentialInput = Schema.Struct({
  accessToken: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.Number.check(Schema.isGreaterThan(0)),
  refreshToken: Schema.String.check(Schema.isNonEmpty())
})

const EnabledInput = Schema.Struct({
  enabled: Schema.Boolean
})

const decodeAccountId = Schema.decodeUnknownEffect(ManagedAccountId)
const decodeCredentialInput = Schema.decodeUnknownEffect(CredentialInput)
const decodeEnabledInput = Schema.decodeUnknownEffect(EnabledInput)

const httpFailure = () =>
  new AccountAdminError({
    message: "The account administration request is invalid"
  })

const parseBody = Effect.fn("AccountAdminHttp.parseBody")(function* (request: Request) {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (!Number.isFinite(length) || length < 0 || length > 16_384) {
      return yield* httpFailure()
    }
  }
  return yield* Effect.tryPromise({
    try: () => request.json(),
    catch: httpFailure
  })
})

const accountPath = (
  path: string
):
  | { readonly accountId: string; readonly operation: "credential" | "enabled" | "account" }
  | undefined => {
  const match = path.match(/^\/admin\/accounts\/([^/]+)(?:\/(credential|enabled))?$/u)
  const encodedAccountId = match?.[1]
  if (encodedAccountId === undefined) {
    return undefined
  }
  const suffix = match?.[2]
  return {
    accountId: encodedAccountId,
    operation: suffix === "credential" ? "credential" : suffix === "enabled" ? "enabled" : "account"
  }
}

const responseError = (status: number, error: string): Response =>
  Response.json({ error }, { status })

export const makeAccountAdminHttpHandler = Effect.fn("makeAccountAdminHttpHandler")(function* () {
  const authenticator = yield* AdminAuthenticator
  const admin = yield* AccountAdmin

  const route = Effect.fn("AccountAdminHttp.route")(function* (request: Request) {
    const authentication = yield* Effect.result(authenticator.authenticate(request))
    if (Result.isFailure(authentication)) {
      return responseError(500, "authentication_unavailable")
    }
    if (!authentication.success) {
      return responseError(401, "unauthorized")
    }

    const url = new URL(request.url)
    if (url.pathname === "/admin/accounts" && request.method === "GET") {
      const accounts = yield* Effect.result(admin.list())
      return Result.isFailure(accounts)
        ? responseError(503, "account_store_unavailable")
        : Response.json({ accounts: accounts.success })
    }

    const parsedPath = accountPath(url.pathname)
    if (parsedPath === undefined) {
      return responseError(404, "not_found")
    }
    const decodedId = yield* Effect.result(decodeAccountId(parsedPath.accountId))
    if (Result.isFailure(decodedId)) {
      return responseError(400, "invalid_account_id")
    }
    const accountId = AccountId.make(decodedId.success)

    if (parsedPath.operation === "credential" && request.method === "PUT") {
      const parsedBody = yield* Effect.result(
        parseBody(request).pipe(Effect.flatMap(decodeCredentialInput))
      )
      if (Result.isFailure(parsedBody)) {
        return responseError(400, "invalid_credential")
      }
      const providerAccountId = yield* Effect.result(
        extractProviderAccountId(parsedBody.success.accessToken)
      )
      if (Result.isFailure(providerAccountId)) {
        return responseError(400, "invalid_credential")
      }
      const stored = yield* Effect.result(
        admin.putCredential(
          accountId,
          SubscriptionCredentialModel.make({
            accessToken: Redacted.make(parsedBody.success.accessToken),
            accountId,
            expiresAt: parsedBody.success.expiresAt,
            generation: 1,
            providerAccountId: providerAccountId.success,
            refreshToken: Redacted.make(parsedBody.success.refreshToken)
          }),
          yield* Clock.currentTimeMillis
        )
      )
      if (Result.isFailure(stored)) {
        return stored.failure instanceof ProviderIdentityConflictError
          ? responseError(409, "provider_identity_conflict")
          : responseError(503, "account_store_unavailable")
      }
      return Response.json(stored.success)
    }

    if (parsedPath.operation === "enabled" && request.method === "POST") {
      const parsedBody = yield* Effect.result(
        parseBody(request).pipe(Effect.flatMap(decodeEnabledInput))
      )
      if (Result.isFailure(parsedBody)) {
        return responseError(400, "invalid_account_state")
      }
      const stored = yield* Effect.result(
        admin.setEnabled(accountId, parsedBody.success.enabled, yield* Clock.currentTimeMillis)
      )
      if (Result.isFailure(stored)) {
        return responseError(503, "account_store_unavailable")
      }
      return Option.isNone(stored.success)
        ? responseError(404, "account_not_found")
        : Response.json(stored.success.value)
    }

    if (parsedPath.operation === "account" && request.method === "DELETE") {
      const removed = yield* Effect.result(admin.remove(accountId))
      if (Result.isFailure(removed)) {
        return responseError(503, "account_store_unavailable")
      }
      return removed.success
        ? new Response(null, { status: 204 })
        : responseError(404, "account_not_found")
    }

    return responseError(404, "not_found")
  })

  return makeRawWebHandler((request) =>
    route(request).pipe(
      Effect.catchCause(() => Effect.succeed(responseError(500, "internal_error")))
    )
  )
})

export const makeAccountAdminFetch = Effect.fn("makeAccountAdminFetch")(function* () {
  const handler = yield* makeAccountAdminHttpHandler()
  return HttpEffect.toWebHandler(handler)
})
