import type { AccountId, Candidate, SelectionReason, SessionKey } from "@akua-dev/codex-router-core"
import { Context, Effect, Option, Schema } from "effect"
import type { SubscriptionCredential } from "./credentials.ts"

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

export class TransportError extends Schema.TaggedErrorClass<TransportError>()("TransportError", {
  message: Schema.String
}) {}

export class ClientAuthenticator extends Context.Service<
  ClientAuthenticator,
  {
    readonly authenticate: (request: Request) => Effect.Effect<boolean, AuthenticationError>
  }
>()("@akua-dev/codex-router/ClientAuthenticator") {}

export class AdminAuthenticator extends Context.Service<
  AdminAuthenticator,
  {
    readonly authenticate: (request: Request) => Effect.Effect<boolean, AuthenticationError>
  }
>()("@akua-dev/codex-router/AdminAuthenticator") {}

export class AccountDirectory extends Context.Service<
  AccountDirectory,
  {
    readonly candidates: Effect.Effect<ReadonlyArray<Candidate>, AccountDirectoryError>
    readonly credential: (
      accountId: AccountId
    ) => Effect.Effect<SubscriptionCredential, CredentialUnavailableError>
  }
>()("@akua-dev/codex-router/AccountDirectory") {}

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
