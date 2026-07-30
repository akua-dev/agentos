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
import type {
  AccountId,
  Candidate,
  SelectionReason,
  SessionKey,
  UsageSnapshot
} from "@akua-dev/codex-router-core"
import { Context, Effect, Option, Redacted, Schema } from "effect"
import { AccountKind } from "./protocol.ts"

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "AuthenticationError",
  {
    message: Schema.String
  }
) {}

export class AccountDirectoryError extends Schema.TaggedErrorClass<AccountDirectoryError>()(
  "AccountDirectoryError",
  {
    message: Schema.String
  }
) {}

export class CredentialUnavailableError extends Schema.TaggedErrorClass<CredentialUnavailableError>()(
  "CredentialUnavailableError",
  {
    message: Schema.String
  }
) {}

export class UsageProbeError extends Schema.TaggedErrorClass<UsageProbeError>()("UsageProbeError", {
  message: Schema.String
}) {}

export class TransportError extends Schema.TaggedErrorClass<TransportError>()("TransportError", {
  message: Schema.String
}) {}

export class AccountCredential extends Schema.Class<AccountCredential>("AccountCredential")({
  accountId: Schema.String.pipe(Schema.brand("AccountId")),
  kind: AccountKind,
  accessToken: Schema.Redacted(Schema.String),
  providerAccountId: Schema.optionalKey(Schema.String)
}) {
  get authorization(): string {
    return `Bearer ${Redacted.value(this.accessToken)}`
  }
}

export class ClientAuthenticator extends Context.Service<
  ClientAuthenticator,
  {
    readonly authenticate: (request: Request) => Effect.Effect<boolean, AuthenticationError>
  }
>()("@akua-dev/codex-router/ClientAuthenticator") {}

export class AccountDirectory extends Context.Service<
  AccountDirectory,
  {
    readonly candidates: Effect.Effect<ReadonlyArray<Candidate>, AccountDirectoryError>
    readonly credential: (
      accountId: AccountId
    ) => Effect.Effect<AccountCredential, CredentialUnavailableError>
  }
>()("@akua-dev/codex-router/AccountDirectory") {}

export class UsageProbe extends Context.Service<
  UsageProbe,
  {
    readonly usage: (accountId: AccountId) => Effect.Effect<UsageSnapshot, UsageProbeError>
  }
>()("@akua-dev/codex-router/UsageProbe") {}

export class UpstreamTransport extends Context.Service<
  UpstreamTransport,
  {
    readonly execute: (request: Request) => Effect.Effect<Response, TransportError>
  }
>()("@akua-dev/codex-router/UpstreamTransport") {}

export interface DecisionTelemetry {
  readonly accountId: AccountId
  readonly reason: SelectionReason
  readonly sessionKey: Option.Option<SessionKey>
}

export interface BookkeepingFailureTelemetry {
  readonly accountId: AccountId
  readonly operation: "record_response"
}

export class GatewayTelemetry extends Context.Service<
  GatewayTelemetry,
  {
    readonly decision: (event: DecisionTelemetry) => Effect.Effect<void>
    readonly bookkeepingFailure: (event: BookkeepingFailureTelemetry) => Effect.Effect<void>
  }
>()("@akua-dev/codex-router/GatewayTelemetry") {}
