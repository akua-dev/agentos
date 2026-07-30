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
