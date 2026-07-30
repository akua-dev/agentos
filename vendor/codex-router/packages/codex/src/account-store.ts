import {
  AccountId,
  RouteLease,
  UsageSnapshot,
  type AccountId as AccountIdType,
  type LeaseToken as LeaseTokenType,
  type RoutingSummary,
  type SessionKey as SessionKeyType,
  type UpstreamResponseClassification
} from "@akua-dev/codex-router-core"
import { Context, Effect, Option, Schema } from "effect"
import { SubscriptionCredential, type CredentialGeneration } from "./credentials.ts"

export const RefreshOperation = Schema.Literals(["credential", "usage"])
export type RefreshOperation = typeof RefreshOperation.Type

export const RefreshClaimToken = Schema.String.pipe(Schema.brand("RefreshClaimToken"))
export type RefreshClaimToken = typeof RefreshClaimToken.Type

export class RefreshClaim extends Schema.Class<RefreshClaim>("RefreshClaim")({
  accountId: AccountId,
  expiresAt: Schema.Number,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  operation: RefreshOperation,
  token: RefreshClaimToken
}) {}

export class SubscriptionAccountState extends Schema.Class<SubscriptionAccountState>(
  "SubscriptionAccountState"
)({
  accountId: AccountId,
  credential: Schema.optionalKey(SubscriptionCredential),
  enabled: Schema.Boolean,
  requiresReauthentication: Schema.Boolean,
  usage: Schema.optionalKey(UsageSnapshot)
}) {}

export class SubscriptionRouteGrant extends Schema.Class<SubscriptionRouteGrant>(
  "SubscriptionRouteGrant"
)({
  credential: SubscriptionCredential,
  lease: RouteLease
}) {}

export class MaintenanceResult extends Schema.Class<MaintenanceResult>("MaintenanceResult")({
  ready: Schema.Natural,
  visited: Schema.Natural
}) {}

export class SubscriptionAccountStoreError extends Schema.TaggedErrorClass<SubscriptionAccountStoreError>()(
  "SubscriptionAccountStoreError",
  {
    message: Schema.String
  }
) {}

export interface SubscriptionAcquireInput {
  readonly accountIds: ReadonlyArray<AccountIdType>
  readonly now: number
  readonly sessionKey?: SessionKeyType
}

export interface CredentialCommit {
  readonly accountId: AccountIdType
  readonly claimToken: RefreshClaimToken
  readonly expectedGeneration: CredentialGeneration
  readonly credential: SubscriptionCredential
}

export interface UsageCommit {
  readonly accountId: AccountIdType
  readonly claimToken: RefreshClaimToken
  readonly expectedGeneration: CredentialGeneration
  readonly usage: UsageSnapshot
}

export interface ResponseRecord {
  readonly accountId: AccountIdType
  readonly classification: UpstreamResponseClassification
  readonly generation: CredentialGeneration
  readonly now: number
}

export interface CredentialReplacement {
  readonly accountId: AccountIdType
  readonly credential: SubscriptionCredential
  readonly now: number
}

export interface SubscriptionAccountStoreShape {
  readonly seedIfAbsent: (
    accounts: ReadonlyArray<SubscriptionAccountState>
  ) => Effect.Effect<number, SubscriptionAccountStoreError>
  readonly list: Effect.Effect<
    ReadonlyArray<SubscriptionAccountState>,
    SubscriptionAccountStoreError
  >
  readonly get: (
    accountId: AccountIdType
  ) => Effect.Effect<Option.Option<SubscriptionAccountState>, SubscriptionAccountStoreError>
  readonly claim: (
    accountId: AccountIdType,
    operation: RefreshOperation,
    generation: CredentialGeneration,
    now: number
  ) => Effect.Effect<Option.Option<RefreshClaim>, SubscriptionAccountStoreError>
  readonly releaseClaim: (
    claimToken: RefreshClaimToken
  ) => Effect.Effect<void, SubscriptionAccountStoreError>
  readonly commitCredential: (
    commit: CredentialCommit
  ) => Effect.Effect<boolean, SubscriptionAccountStoreError>
  readonly commitUsage: (
    commit: UsageCommit
  ) => Effect.Effect<boolean, SubscriptionAccountStoreError>
  readonly markRequiresReauthentication: (
    accountId: AccountIdType,
    generation: CredentialGeneration
  ) => Effect.Effect<boolean, SubscriptionAccountStoreError>
  readonly replaceCredential: (
    replacement: CredentialReplacement
  ) => Effect.Effect<Option.Option<SubscriptionAccountState>, SubscriptionAccountStoreError>
  readonly setEnabled: (
    accountId: AccountIdType,
    enabled: boolean,
    now: number
  ) => Effect.Effect<Option.Option<SubscriptionAccountState>, SubscriptionAccountStoreError>
  readonly remove: (
    accountId: AccountIdType
  ) => Effect.Effect<boolean, SubscriptionAccountStoreError>
  readonly acquire: (
    input: SubscriptionAcquireInput
  ) => Effect.Effect<Option.Option<SubscriptionRouteGrant>, SubscriptionAccountStoreError>
  readonly renew: (
    leaseToken: LeaseTokenType,
    now: number
  ) => Effect.Effect<boolean, SubscriptionAccountStoreError>
  readonly release: (
    leaseToken: LeaseTokenType
  ) => Effect.Effect<void, SubscriptionAccountStoreError>
  readonly recordResponse: (
    input: ResponseRecord
  ) => Effect.Effect<void, SubscriptionAccountStoreError>
  readonly summary: (now: number) => Effect.Effect<RoutingSummary, SubscriptionAccountStoreError>
}

export class SubscriptionAccountStore extends Context.Service<
  SubscriptionAccountStore,
  SubscriptionAccountStoreShape
>()("@akua-dev/codex-router/SubscriptionAccountStore") {}
