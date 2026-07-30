import { Context, Effect, Option } from "effect"
import type { RoutingStateError } from "./errors.ts"
import type {
  AccountId,
  Candidate,
  LeaseToken,
  RouteLease,
  RoutingSummary,
  SessionKey
} from "./model.ts"
import type { UpstreamResponseClassification } from "./upstream-status.ts"

export interface AcquireRouteInput {
  readonly candidates: ReadonlyArray<Candidate>
  readonly now: number
  readonly sessionKey?: SessionKey
}

export interface RoutingStateShape {
  readonly acquire: (
    input: AcquireRouteInput
  ) => Effect.Effect<Option.Option<RouteLease>, RoutingStateError>
  readonly renew: (leaseToken: LeaseToken, now: number) => Effect.Effect<boolean, RoutingStateError>
  readonly release: (leaseToken: LeaseToken) => Effect.Effect<void, RoutingStateError>
  readonly recordResponse: (
    accountId: AccountId,
    classification: UpstreamResponseClassification,
    now: number
  ) => Effect.Effect<void, RoutingStateError>
  readonly summary: (now: number) => Effect.Effect<RoutingSummary, RoutingStateError>
}

export class RoutingState extends Context.Service<RoutingState, RoutingStateShape>()(
  "@akua-dev/codex-router/RoutingState"
) {}

export const acquireRoute = Effect.fn("RoutingState.acquire")(function* (input: AcquireRouteInput) {
  const state = yield* RoutingState
  return yield* state.acquire(input)
})

export const renewRoute = Effect.fn("RoutingState.renew")(function* (
  leaseToken: LeaseToken,
  now: number
) {
  const state = yield* RoutingState
  return yield* state.renew(leaseToken, now)
})

export const releaseRoute = Effect.fn("RoutingState.release")(function* (leaseToken: LeaseToken) {
  const state = yield* RoutingState
  return yield* state.release(leaseToken)
})

export const recordUpstreamResponse = Effect.fn("RoutingState.recordResponse")(function* (
  accountId: AccountId,
  classification: UpstreamResponseClassification,
  now: number
) {
  const state = yield* RoutingState
  return yield* state.recordResponse(accountId, classification, now)
})
