import {
  Candidate,
  RoutingState,
  UpstreamResponseClassification,
  type AccountId,
  type UsageSnapshot
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Option, Redacted, SynchronizedRef } from "effect"
import {
  RefreshClaim,
  RefreshClaimToken,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionAccountStoreError,
  SubscriptionRouteGrant,
  type SubscriptionAccountStoreShape
} from "../account-store.ts"
import { SubscriptionCredential } from "../credentials.ts"

interface StoreState {
  readonly accounts: ReadonlyMap<AccountId, SubscriptionAccountState>
  readonly claims: ReadonlyMap<RefreshClaimToken, RefreshClaim>
  readonly sequence: number
}

const transition = <A>(value: A, state: StoreState): readonly [A, StoreState] => [value, state]

const storeFailure = () =>
  new SubscriptionAccountStoreError({
    message: "The in-memory routing state operation failed"
  })

const cleanClaims = (
  claims: ReadonlyMap<RefreshClaimToken, RefreshClaim>,
  now: number
): ReadonlyMap<RefreshClaimToken, RefreshClaim> =>
  new Map([...claims].filter(([, claim]) => claim.expiresAt > now))

const replaceAccount = (
  source: SubscriptionAccountState,
  options: {
    readonly credential?: SubscriptionCredential
    readonly requiresReauthentication?: boolean
    readonly usage?: UsageSnapshot
  }
): SubscriptionAccountState =>
  SubscriptionAccountState.make({
    accountId: source.accountId,
    enabled: source.enabled,
    requiresReauthentication: options.requiresReauthentication ?? source.requiresReauthentication,
    ...(options.credential === undefined
      ? source.credential === undefined
        ? {}
        : { credential: source.credential }
      : { credential: options.credential }),
    ...(options.usage === undefined
      ? source.usage === undefined
        ? {}
        : { usage: source.usage }
      : { usage: options.usage })
  })

const candidateFromAccount = (account: SubscriptionAccountState): Candidate =>
  Candidate.make({
    accountId: account.accountId,
    activeReservations: 0,
    requiresReauthentication: account.requiresReauthentication,
    ...(account.usage === undefined ? {} : { usage: account.usage })
  })

export const makeInMemorySubscriptionAccountStore = Effect.fn(
  "makeInMemorySubscriptionAccountStore"
)(function* (initial: ReadonlyArray<SubscriptionAccountState>) {
  const routing = yield* RoutingState
  const ref = yield* SynchronizedRef.make<StoreState>({
    accounts: new Map(initial.map((account) => [account.accountId, account])),
    claims: new Map(),
    sequence: 0
  })

  const seedIfAbsent: SubscriptionAccountStoreShape["seedIfAbsent"] = Effect.fn(
    "InMemorySubscriptionAccountStore.seedIfAbsent"
  )((accounts) =>
    SynchronizedRef.modify(ref, (state) => {
      const next = new Map(state.accounts)
      let inserted = 0
      for (const account of accounts) {
        if (!next.has(account.accountId)) {
          next.set(account.accountId, account)
          inserted += 1
        }
      }
      return transition(inserted, { ...state, accounts: next })
    })
  )

  const list: SubscriptionAccountStoreShape["list"] = SynchronizedRef.get(ref).pipe(
    Effect.map((state) => [...state.accounts.values()])
  )

  const get: SubscriptionAccountStoreShape["get"] = Effect.fn(
    "InMemorySubscriptionAccountStore.get"
  )((accountId) =>
    SynchronizedRef.get(ref).pipe(
      Effect.map((state) => Option.fromNullishOr(state.accounts.get(accountId)))
    )
  )

  const claim: SubscriptionAccountStoreShape["claim"] = Effect.fn(
    "InMemorySubscriptionAccountStore.claim"
  )((accountId, operation, generation, now) =>
    SynchronizedRef.modify(ref, (state) => {
      const claims = cleanClaims(state.claims, now)
      const account = state.accounts.get(accountId)
      const alreadyClaimed = [...claims.values()].some(
        (value) => value.accountId === accountId && value.operation === operation
      )
      if (
        account?.credential?.generation !== generation ||
        account.requiresReauthentication ||
        alreadyClaimed
      ) {
        return transition(Option.none<RefreshClaim>(), { ...state, claims })
      }
      const sequence = state.sequence + 1
      const token = RefreshClaimToken.make(`in-memory-claim-${sequence}`)
      const refreshClaim = RefreshClaim.make({
        accountId,
        expiresAt: now + 30_000,
        generation,
        operation,
        token
      })
      const next = new Map(claims)
      next.set(token, refreshClaim)
      return transition(Option.some(refreshClaim), {
        ...state,
        claims: next,
        sequence
      })
    })
  )

  const releaseClaim: SubscriptionAccountStoreShape["releaseClaim"] = Effect.fn(
    "InMemorySubscriptionAccountStore.releaseClaim"
  )((claimToken) =>
    SynchronizedRef.update(ref, (state) => {
      const claims = new Map(state.claims)
      claims.delete(claimToken)
      return { ...state, claims }
    })
  )

  const commitCredential: SubscriptionAccountStoreShape["commitCredential"] = Effect.fn(
    "InMemorySubscriptionAccountStore.commitCredential"
  )((commit) =>
    SynchronizedRef.modify(ref, (state) => {
      const account = state.accounts.get(commit.accountId)
      const claim = state.claims.get(commit.claimToken)
      if (
        account?.credential?.generation !== commit.expectedGeneration ||
        claim?.accountId !== commit.accountId ||
        claim.operation !== "credential" ||
        claim.generation !== commit.expectedGeneration ||
        commit.credential.generation !== commit.expectedGeneration + 1
      ) {
        return transition(false, state)
      }
      const accounts = new Map(state.accounts)
      accounts.set(
        commit.accountId,
        replaceAccount(account, {
          credential: commit.credential,
          requiresReauthentication: false
        })
      )
      const claims = new Map(state.claims)
      claims.delete(commit.claimToken)
      return transition(true, { ...state, accounts, claims })
    })
  )

  const commitUsage: SubscriptionAccountStoreShape["commitUsage"] = Effect.fn(
    "InMemorySubscriptionAccountStore.commitUsage"
  )((commit) =>
    SynchronizedRef.modify(ref, (state) => {
      const account = state.accounts.get(commit.accountId)
      const claim = state.claims.get(commit.claimToken)
      if (
        account?.credential?.generation !== commit.expectedGeneration ||
        claim?.accountId !== commit.accountId ||
        claim.operation !== "usage" ||
        claim.generation !== commit.expectedGeneration ||
        commit.usage.accountId !== commit.accountId
      ) {
        return transition(false, state)
      }
      const accounts = new Map(state.accounts)
      accounts.set(commit.accountId, replaceAccount(account, { usage: commit.usage }))
      const claims = new Map(state.claims)
      claims.delete(commit.claimToken)
      return transition(true, { ...state, accounts, claims })
    })
  )

  const markRequiresReauthentication: SubscriptionAccountStoreShape["markRequiresReauthentication"] =
    Effect.fn("InMemorySubscriptionAccountStore.markRequiresReauthentication")(
      (accountId, generation) =>
        SynchronizedRef.modify(ref, (state) => {
          const account = state.accounts.get(accountId)
          if (account?.credential?.generation !== generation) {
            return transition(false, state)
          }
          const accounts = new Map(state.accounts)
          accounts.set(accountId, replaceAccount(account, { requiresReauthentication: true }))
          return transition(true, { ...state, accounts })
        })
    )

  const replaceCredential: SubscriptionAccountStoreShape["replaceCredential"] = Effect.fn(
    "InMemorySubscriptionAccountStore.replaceCredential"
  )(function* (replacement) {
    const replaced = yield* SynchronizedRef.modify(ref, (state) => {
      const existing = state.accounts.get(replacement.accountId)
      if (
        existing?.credential !== undefined &&
        Redacted.value(existing.credential.providerAccountId) !==
          Redacted.value(replacement.credential.providerAccountId)
      ) {
        return transition(Option.none<SubscriptionAccountState>(), state)
      }
      const generation = (existing?.credential?.generation ?? 0) + 1
      const credential = SubscriptionCredential.make({
        accessToken: replacement.credential.accessToken,
        accountId: replacement.accountId,
        expiresAt: replacement.credential.expiresAt,
        generation,
        providerAccountId: replacement.credential.providerAccountId,
        refreshToken: replacement.credential.refreshToken
      })
      const account = SubscriptionAccountState.make({
        accountId: replacement.accountId,
        credential,
        enabled: existing?.enabled ?? true,
        requiresReauthentication: false
      })
      const accounts = new Map(state.accounts)
      accounts.set(replacement.accountId, account)
      const claims = new Map(
        [...state.claims].filter(([, claim]) => claim.accountId !== replacement.accountId)
      )
      return transition(Option.some(account), { ...state, accounts, claims })
    })
    if (Option.isSome(replaced)) {
      yield* routing
        .recordResponse(
          replacement.accountId,
          UpstreamResponseClassification.make({
            kind: "success",
            retryAt: Option.none()
          }),
          replacement.now
        )
        .pipe(Effect.mapError(storeFailure))
    }
    return replaced
  })

  const setEnabled: SubscriptionAccountStoreShape["setEnabled"] = Effect.fn(
    "InMemorySubscriptionAccountStore.setEnabled"
  )((accountId, enabled) =>
    SynchronizedRef.modify(ref, (state) => {
      const existing = state.accounts.get(accountId)
      if (existing === undefined) {
        return transition(Option.none<SubscriptionAccountState>(), state)
      }
      const account = SubscriptionAccountState.make({
        accountId,
        enabled,
        requiresReauthentication: existing.requiresReauthentication,
        ...(existing.credential === undefined ? {} : { credential: existing.credential }),
        ...(existing.usage === undefined ? {} : { usage: existing.usage })
      })
      const accounts = new Map(state.accounts)
      accounts.set(accountId, account)
      return transition(Option.some(account), { ...state, accounts })
    })
  )

  const remove: SubscriptionAccountStoreShape["remove"] = Effect.fn(
    "InMemorySubscriptionAccountStore.remove"
  )((accountId) =>
    SynchronizedRef.modify(ref, (state) => {
      if (!state.accounts.has(accountId)) {
        return transition(false, state)
      }
      const accounts = new Map(state.accounts)
      accounts.delete(accountId)
      const claims = new Map([...state.claims].filter(([, claim]) => claim.accountId !== accountId))
      return transition(true, { ...state, accounts, claims })
    })
  )

  const acquire: SubscriptionAccountStoreShape["acquire"] = Effect.fn(
    "InMemorySubscriptionAccountStore.acquire"
  )(function* (input) {
    const state = yield* SynchronizedRef.get(ref)
    const allowed = new Set(input.accountIds)
    const candidates = [...state.accounts.values()]
      .filter(
        (account) =>
          allowed.has(account.accountId) &&
          account.enabled &&
          account.credential !== undefined &&
          account.credential.expiresAt > input.now
      )
      .map(candidateFromAccount)
    const lease = yield* routing
      .acquire({
        candidates,
        now: input.now,
        ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
      })
      .pipe(Effect.mapError(storeFailure))
    if (Option.isNone(lease)) {
      return Option.none<SubscriptionRouteGrant>()
    }
    const selected = yield* SynchronizedRef.get(ref)
    const selectedCredential = selected.accounts.get(lease.value.accountId)?.credential
    if (selectedCredential === undefined) {
      yield* routing.release(lease.value.leaseToken).pipe(Effect.mapError(storeFailure))
      return Option.none<SubscriptionRouteGrant>()
    }
    return Option.some(
      SubscriptionRouteGrant.make({
        credential: selectedCredential,
        lease: lease.value
      })
    )
  })

  const renew: SubscriptionAccountStoreShape["renew"] = Effect.fn(
    "InMemorySubscriptionAccountStore.renew"
  )((leaseToken, now) => routing.renew(leaseToken, now).pipe(Effect.mapError(storeFailure)))

  const release: SubscriptionAccountStoreShape["release"] = Effect.fn(
    "InMemorySubscriptionAccountStore.release"
  )((leaseToken) => routing.release(leaseToken).pipe(Effect.mapError(storeFailure)))

  const recordResponse: SubscriptionAccountStoreShape["recordResponse"] = Effect.fn(
    "InMemorySubscriptionAccountStore.recordResponse"
  )(function* (input) {
    const current = yield* get(input.accountId)
    if (Option.isNone(current) || current.value.credential?.generation !== input.generation) {
      return
    }
    if (input.classification.kind === "reauth") {
      yield* markRequiresReauthentication(input.accountId, input.generation)
    }
    yield* routing
      .recordResponse(input.accountId, input.classification, input.now)
      .pipe(Effect.mapError(storeFailure))
  })

  const summary: SubscriptionAccountStoreShape["summary"] = Effect.fn(
    "InMemorySubscriptionAccountStore.summary"
  )((now) => routing.summary(now).pipe(Effect.mapError(storeFailure)))

  return SubscriptionAccountStore.of({
    acquire,
    claim,
    commitCredential,
    commitUsage,
    get,
    list,
    markRequiresReauthentication,
    recordResponse,
    remove,
    replaceCredential,
    release,
    releaseClaim,
    renew,
    seedIfAbsent,
    setEnabled,
    summary
  })
})

export const inMemorySubscriptionAccountStoreLayer = (
  initial: ReadonlyArray<SubscriptionAccountState>
) => Layer.effect(SubscriptionAccountStore, makeInMemorySubscriptionAccountStore(initial))
