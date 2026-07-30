import { Effect, Layer, Option, SynchronizedRef } from "effect"
import {
  AccountBlock,
  AccountRoutingSummary,
  Candidate,
  LeaseToken,
  Reservation,
  RouteLease,
  RoutingSummary,
  SessionAssignment,
  type AccountId,
  type RoutingConfig,
  type SessionKey
} from "../model.ts"
import { selectAccount } from "../selection.ts"
import { RoutingState, type RoutingStateShape } from "../services.ts"
import type { UpstreamResponseClassification } from "../upstream-status.ts"

interface AccountHealth {
  readonly requiresReauthentication: boolean
  readonly block?: AccountBlock
}

interface State {
  readonly assignments: ReadonlyMap<SessionKey, SessionAssignment>
  readonly reservations: ReadonlyMap<LeaseToken, Reservation>
  readonly health: ReadonlyMap<AccountId, AccountHealth>
  readonly sequence: number
}

const initialState: State = {
  assignments: new Map(),
  reservations: new Map(),
  health: new Map(),
  sequence: 0
}

const transition = <A>(result: A, state: State): readonly [A, State] => [result, state]

const cleanState = (state: State, now: number, config: RoutingConfig): State => {
  const reservations = new Map(
    [...state.reservations].filter(([, reservation]) => reservation.expiresAt > now)
  )
  const assignments = new Map(
    [...state.assignments].filter(
      ([, assignment]) => assignment.updatedAt + config.assignmentTtlMs > now
    )
  )
  const health = new Map(
    [...state.health].map(([accountId, entry]) => {
      if (entry.block?.retryAt !== undefined && entry.block.retryAt <= now) {
        return [accountId, { requiresReauthentication: entry.requiresReauthentication }]
      }
      return [accountId, entry]
    })
  )
  return {
    assignments,
    health,
    reservations,
    sequence: state.sequence
  }
}

const reservationCount = (
  reservations: ReadonlyMap<LeaseToken, Reservation>,
  accountId: AccountId
): number =>
  [...reservations.values()].filter((reservation) => reservation.accountId === accountId).length

const overlayCandidate = (candidate: Candidate, state: State): Candidate => {
  const health = state.health.get(candidate.accountId)
  return Candidate.make({
    accountId: candidate.accountId,
    activeReservations:
      candidate.activeReservations + reservationCount(state.reservations, candidate.accountId),
    requiresReauthentication:
      candidate.requiresReauthentication || health?.requiresReauthentication === true,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
    ...(health?.block === undefined
      ? candidate.block === undefined
        ? {}
        : { block: candidate.block }
      : { block: health.block })
  })
}

const healthFromClassification = (
  previous: AccountHealth | undefined,
  classification: UpstreamResponseClassification,
  now: number
): AccountHealth | undefined => {
  if (classification.kind === "success") {
    return undefined
  }
  if (classification.kind === "reauth") {
    return { requiresReauthentication: true }
  }
  if (classification.kind === "quota") {
    const retryAt = Option.getOrUndefined(classification.retryAt)
    return {
      requiresReauthentication: previous?.requiresReauthentication === true,
      block:
        retryAt === undefined
          ? AccountBlock.make({ kind: "quota" })
          : AccountBlock.make({ kind: "quota", retryAt })
    }
  }
  if (classification.kind === "transient") {
    return {
      requiresReauthentication: previous?.requiresReauthentication === true,
      block: AccountBlock.make({
        kind: "transient",
        retryAt: Option.getOrElse(classification.retryAt, () => now + 30_000)
      })
    }
  }
  return previous
}

export const makeInMemoryRoutingState = Effect.fn("makeInMemoryRoutingState")(function* (
  config: RoutingConfig
) {
  const ref = yield* SynchronizedRef.make(initialState)

  const acquire: RoutingStateShape["acquire"] = Effect.fn("InMemoryRoutingState.acquire")((input) =>
    SynchronizedRef.modifyEffect(ref, (unsafeState) =>
      Effect.gen(function* () {
        const state = cleanState(unsafeState, input.now, config)
        const currentAccountId =
          input.sessionKey === undefined
            ? undefined
            : state.assignments.get(input.sessionKey)?.accountId
        const candidates = input.candidates.map((candidate) => overlayCandidate(candidate, state))
        const decision = yield* Effect.option(
          selectAccount({
            candidates,
            config,
            now: input.now,
            ...(currentAccountId === undefined ? {} : { currentAccountId })
          })
        )
        if (Option.isNone(decision)) {
          return transition(Option.none<RouteLease>(), state)
        }

        const sequence = state.sequence + 1
        const leaseToken = LeaseToken.make(`in-memory-lease-${sequence}`)
        const sessionKey =
          input.sessionKey === undefined ? Option.none<SessionKey>() : Option.some(input.sessionKey)
        const reservation = Reservation.make({
          accountId: decision.value.accountId,
          createdAt: input.now,
          expiresAt: input.now + config.leaseTtlMs,
          leaseToken,
          sessionKey
        })
        const reservations = new Map(state.reservations)
        reservations.set(leaseToken, reservation)
        const assignments = new Map(state.assignments)
        if (input.sessionKey !== undefined) {
          assignments.set(
            input.sessionKey,
            SessionAssignment.make({
              accountId: decision.value.accountId,
              sessionKey: input.sessionKey,
              updatedAt: input.now
            })
          )
        }
        const lease = RouteLease.make({
          accountId: reservation.accountId,
          expiresAt: reservation.expiresAt,
          leaseToken,
          sessionKey
        })
        return transition(Option.some(lease), {
          ...state,
          assignments,
          reservations,
          sequence
        })
      })
    )
  )

  const renew: RoutingStateShape["renew"] = Effect.fn("InMemoryRoutingState.renew")(
    (leaseToken, now) =>
      SynchronizedRef.modify(ref, (unsafeState) => {
        const state = cleanState(unsafeState, now, config)
        const reservation = state.reservations.get(leaseToken)
        if (reservation === undefined) {
          return transition(false, state)
        }
        const reservations = new Map(state.reservations)
        reservations.set(
          leaseToken,
          Reservation.make({
            accountId: reservation.accountId,
            createdAt: reservation.createdAt,
            expiresAt: now + config.leaseTtlMs,
            leaseToken,
            sessionKey: reservation.sessionKey
          })
        )
        return transition(true, { ...state, reservations })
      })
  )

  const release: RoutingStateShape["release"] = Effect.fn("InMemoryRoutingState.release")(
    (leaseToken) =>
      SynchronizedRef.update(ref, (state) => {
        const reservations = new Map(state.reservations)
        reservations.delete(leaseToken)
        return { ...state, reservations }
      })
  )

  const recordResponse: RoutingStateShape["recordResponse"] = Effect.fn(
    "InMemoryRoutingState.recordResponse"
  )((accountId, classification, now) =>
    SynchronizedRef.update(ref, (state) => {
      const health = new Map(state.health)
      const next = healthFromClassification(health.get(accountId), classification, now)
      if (next === undefined) {
        health.delete(accountId)
      } else {
        health.set(accountId, next)
      }
      return { ...state, health }
    })
  )

  const summary: RoutingStateShape["summary"] = Effect.fn("InMemoryRoutingState.summary")((now) =>
    SynchronizedRef.modify(ref, (unsafeState) => {
      const state = cleanState(unsafeState, now, config)
      const accountIds = new Set<AccountId>()
      for (const reservation of state.reservations.values()) {
        accountIds.add(reservation.accountId)
      }
      for (const assignment of state.assignments.values()) {
        accountIds.add(assignment.accountId)
      }
      for (const accountId of state.health.keys()) {
        accountIds.add(accountId)
      }
      const accounts = [...accountIds]
        .sort((left, right) => left.localeCompare(right))
        .map((accountId) => {
          const health = state.health.get(accountId)
          return AccountRoutingSummary.make({
            accountId,
            activeReservations: reservationCount(state.reservations, accountId),
            blockKind: health?.block === undefined ? Option.none() : Option.some(health.block.kind),
            requiresReauthentication: health?.requiresReauthentication === true
          })
        })
      return transition(
        RoutingSummary.make({
          accounts,
          activeReservations: state.reservations.size,
          assignments: state.assignments.size
        }),
        state
      )
    })
  )

  return RoutingState.of({
    acquire,
    recordResponse,
    release,
    renew,
    summary
  })
})

export const inMemoryRoutingStateLayer = (config: RoutingConfig) =>
  Layer.effect(RoutingState, makeInMemoryRoutingState(config))
