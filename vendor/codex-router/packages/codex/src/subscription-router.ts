import type {
  AccountId,
  LeaseToken,
  SessionKey,
  UpstreamResponseClassification
} from "@akua-dev/codex-router-core"
import { RoutingState } from "@akua-dev/codex-router-core"
import { Context, Effect, Layer, Option, Result, Schedule, Schema } from "effect"
import {
  MaintenanceResult,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionRouteGrant
} from "./account-store.ts"
import { OAuthClient, OAuthInvalidGrantError, ProviderIdentityChangedError } from "./oauth.ts"
import { UsageAuthenticationError, UsageProbe } from "./live-usage.ts"
import { AccountDirectory } from "./services.ts"

const refreshEarlyMs = 5 * 60 * 1_000
const usageFreshnessMs = 60_000
const maximumUsageAgeMs = 24 * 60 * 60 * 1_000

export interface RouterAcquireInput {
  readonly now: number
  readonly sessionKey?: SessionKey
}

export class SubscriptionRouterError extends Schema.TaggedErrorClass<SubscriptionRouterError>()(
  "SubscriptionRouterError",
  {
    message: Schema.String
  }
) {}

export interface SubscriptionRouterShape {
  readonly acquire: (
    input: RouterAcquireInput
  ) => Effect.Effect<Option.Option<SubscriptionRouteGrant>, SubscriptionRouterError>
  readonly renew: (
    leaseToken: LeaseToken,
    now: number
  ) => Effect.Effect<boolean, SubscriptionRouterError>
  readonly release: (leaseToken: LeaseToken) => Effect.Effect<void, SubscriptionRouterError>
  readonly recordResponse: (
    accountId: AccountId,
    generation: number,
    classification: UpstreamResponseClassification,
    now: number
  ) => Effect.Effect<void, SubscriptionRouterError>
  readonly maintain: (now: number) => Effect.Effect<MaintenanceResult, SubscriptionRouterError>
}

export class SubscriptionRouter extends Context.Service<
  SubscriptionRouter,
  SubscriptionRouterShape
>()("@akua-dev/codex-router/SubscriptionRouter") {}

class CoordinationPending extends Schema.TaggedErrorClass<CoordinationPending>()(
  "CoordinationPending",
  {
    message: Schema.String
  }
) {}

const routerFailure = () =>
  new SubscriptionRouterError({
    message: "Subscription routing state is unavailable"
  })

const waitPolicy = Schedule.recurs(200)

const pending = (message: string) =>
  Effect.yieldNow.pipe(Effect.andThen(Effect.fail(new CoordinationPending({ message }))))

const isFreshUsage = (account: SubscriptionAccountState, now: number): boolean =>
  account.usage !== undefined && now - account.usage.observedAt < usageFreshnessMs

const hasUsableStaleUsage = (account: SubscriptionAccountState, now: number): boolean =>
  account.usage !== undefined && now - account.usage.observedAt <= maximumUsageAgeMs

export const makeSubscriptionRouter = Effect.fn("makeSubscriptionRouter")(function* () {
  const store = yield* SubscriptionAccountStore
  const oauth = yield* OAuthClient
  const usage = yield* UsageProbe

  const getAccount = Effect.fn("SubscriptionRouter.getAccount")(function* (accountId: AccountId) {
    return yield* store.get(accountId).pipe(Effect.mapError(routerFailure))
  })

  const waitForCredentialChange = Effect.fn("SubscriptionRouter.waitForCredentialChange")(
    function* (accountId: AccountId, generation: number) {
      return yield* getAccount(accountId).pipe(
        Effect.flatMap((account) => {
          if (
            Option.isSome(account) &&
            (account.value.requiresReauthentication ||
              account.value.credential?.generation !== generation)
          ) {
            return Effect.succeed(true)
          }
          return pending("Credential refresh is still in progress")
        }),
        Effect.retry(waitPolicy),
        Effect.catchTag("CoordinationPending", () => Effect.succeed(false))
      )
    }
  )

  const ensureCredential = Effect.fn("SubscriptionRouter.ensureCredential")(function* (
    source: SubscriptionAccountState,
    now: number
  ) {
    const credential = source.credential
    if (!source.enabled || source.requiresReauthentication || credential === undefined) {
      return false
    }
    if (credential.expiresAt > now + refreshEarlyMs) {
      return true
    }
    const claim = yield* store
      .claim(source.accountId, "credential", credential.generation, now)
      .pipe(Effect.mapError(routerFailure))
    if (Option.isNone(claim)) {
      const changed = yield* waitForCredentialChange(source.accountId, credential.generation)
      if (!changed) {
        return false
      }
      const current = yield* getAccount(source.accountId)
      return (
        Option.isSome(current) &&
        !current.value.requiresReauthentication &&
        current.value.credential !== undefined &&
        current.value.credential.expiresAt > now
      )
    }

    const refreshed = yield* Effect.result(oauth.refresh(credential))
    if (Result.isFailure(refreshed)) {
      if (
        refreshed.failure instanceof OAuthInvalidGrantError ||
        refreshed.failure instanceof ProviderIdentityChangedError
      ) {
        yield* store
          .markRequiresReauthentication(source.accountId, credential.generation)
          .pipe(Effect.mapError(routerFailure))
      }
      yield* store.releaseClaim(claim.value.token).pipe(Effect.mapError(routerFailure))
      return false
    }
    const committed = yield* store
      .commitCredential({
        accountId: source.accountId,
        claimToken: claim.value.token,
        credential: refreshed.success,
        expectedGeneration: credential.generation
      })
      .pipe(Effect.mapError(routerFailure))
    if (!committed) {
      yield* store.releaseClaim(claim.value.token).pipe(Effect.mapError(routerFailure))
    }
    return committed
  })

  const waitForUsageChange = Effect.fn("SubscriptionRouter.waitForUsageChange")(function* (
    source: SubscriptionAccountState,
    generation: number,
    now: number
  ) {
    const previousObservedAt = source.usage?.observedAt
    return yield* getAccount(source.accountId).pipe(
      Effect.flatMap((account) => {
        if (Option.isSome(account)) {
          const current = account.value
          if (
            current.requiresReauthentication ||
            current.credential?.generation !== generation ||
            current.usage?.observedAt !== previousObservedAt
          ) {
            return Effect.succeed(
              !current.requiresReauthentication && hasUsableStaleUsage(current, now)
            )
          }
        }
        return pending("Usage refresh is still in progress")
      }),
      Effect.retry(waitPolicy),
      Effect.catchTag("CoordinationPending", () => Effect.succeed(hasUsableStaleUsage(source, now)))
    )
  })

  const ensureUsage = Effect.fn("SubscriptionRouter.ensureUsage")(function* (
    source: SubscriptionAccountState,
    now: number
  ) {
    if (isFreshUsage(source, now)) {
      return true
    }
    const credential = source.credential
    if (credential === undefined || source.requiresReauthentication || !source.enabled) {
      return false
    }
    const claim = yield* store
      .claim(source.accountId, "usage", credential.generation, now)
      .pipe(Effect.mapError(routerFailure))
    if (Option.isNone(claim)) {
      return yield* waitForUsageChange(source, credential.generation, now)
    }
    const probed = yield* Effect.result(usage.getUsage(credential))
    if (Result.isFailure(probed)) {
      if (probed.failure instanceof UsageAuthenticationError) {
        yield* store
          .markRequiresReauthentication(source.accountId, credential.generation)
          .pipe(Effect.mapError(routerFailure))
      }
      yield* store.releaseClaim(claim.value.token).pipe(Effect.mapError(routerFailure))
      return hasUsableStaleUsage(source, now)
    }
    const committed = yield* store
      .commitUsage({
        accountId: source.accountId,
        claimToken: claim.value.token,
        expectedGeneration: credential.generation,
        usage: probed.success
      })
      .pipe(Effect.mapError(routerFailure))
    if (!committed) {
      yield* store.releaseClaim(claim.value.token).pipe(Effect.mapError(routerFailure))
    }
    return committed
  })

  const prepareAccount = Effect.fn("SubscriptionRouter.prepareAccount")(function* (
    source: SubscriptionAccountState,
    now: number
  ) {
    if (!(yield* ensureCredential(source, now))) {
      return false
    }
    const current = yield* getAccount(source.accountId)
    return Option.isSome(current) && (yield* ensureUsage(current.value, now))
  })

  const prepareAll = Effect.fn("SubscriptionRouter.prepareAll")(function* (now: number) {
    const accounts = yield* store.list.pipe(Effect.mapError(routerFailure))
    const ready = yield* Effect.forEach(
      accounts,
      (account) =>
        prepareAccount(account, now).pipe(
          Effect.map((prepared) => ({ accountId: account.accountId, prepared }))
        ),
      { concurrency: "unbounded" }
    )
    return {
      accounts,
      ready: ready.filter((entry) => entry.prepared).map((entry) => entry.accountId)
    }
  })

  return SubscriptionRouter.of({
    acquire: Effect.fn("SubscriptionRouter.acquire")(function* (input) {
      const prepared = yield* prepareAll(input.now)
      return yield* store
        .acquire({
          accountIds: prepared.ready,
          now: input.now,
          ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
        })
        .pipe(Effect.mapError(routerFailure))
    }),
    maintain: Effect.fn("SubscriptionRouter.maintain")(function* (now) {
      const prepared = yield* prepareAll(now)
      return MaintenanceResult.make({
        ready: prepared.ready.length,
        visited: prepared.accounts.length
      })
    }),
    recordResponse: Effect.fn("SubscriptionRouter.recordResponse")(
      (accountId, generation, classification, now) =>
        store
          .recordResponse({
            accountId,
            classification,
            generation,
            now
          })
          .pipe(Effect.mapError(routerFailure))
    ),
    release: Effect.fn("SubscriptionRouter.release")((leaseToken) =>
      store.release(leaseToken).pipe(Effect.mapError(routerFailure))
    ),
    renew: Effect.fn("SubscriptionRouter.renew")((leaseToken, now) =>
      store.renew(leaseToken, now).pipe(Effect.mapError(routerFailure))
    )
  })
})

export const subscriptionRouterLayer = Layer.effect(SubscriptionRouter, makeSubscriptionRouter())

export const configuredSubscriptionRouterLayer = Layer.effect(
  SubscriptionRouter,
  Effect.gen(function* () {
    const directory = yield* AccountDirectory
    const state = yield* RoutingState
    return SubscriptionRouter.of({
      acquire: Effect.fn("ConfiguredSubscriptionRouter.acquire")(function* (input) {
        const candidates = yield* directory.candidates.pipe(Effect.mapError(routerFailure))
        const lease = yield* state
          .acquire({
            candidates,
            now: input.now,
            ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
          })
          .pipe(Effect.mapError(routerFailure))
        if (Option.isNone(lease)) {
          return Option.none<SubscriptionRouteGrant>()
        }
        const credential = yield* directory
          .credential(lease.value.accountId)
          .pipe(Effect.mapError(routerFailure))
        return Option.some(
          SubscriptionRouteGrant.make({
            credential,
            lease: lease.value
          })
        )
      }),
      maintain: Effect.fn("ConfiguredSubscriptionRouter.maintain")(function* () {
        const candidates = yield* directory.candidates.pipe(Effect.mapError(routerFailure))
        return MaintenanceResult.make({
          ready: candidates.length,
          visited: candidates.length
        })
      }),
      recordResponse: Effect.fn("ConfiguredSubscriptionRouter.recordResponse")(
        (accountId, _generation, classification, now) =>
          state.recordResponse(accountId, classification, now).pipe(Effect.mapError(routerFailure))
      ),
      release: Effect.fn("ConfiguredSubscriptionRouter.release")((leaseToken) =>
        state.release(leaseToken).pipe(Effect.mapError(routerFailure))
      ),
      renew: Effect.fn("ConfiguredSubscriptionRouter.renew")((leaseToken, now) =>
        state.renew(leaseToken, now).pipe(Effect.mapError(routerFailure))
      )
    })
  })
)
