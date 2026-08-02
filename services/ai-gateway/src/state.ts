import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { Context, Effect, Schema } from "effect";

import type {
  FreshCredential,
  ManagedAccountSummary,
} from "./effect-accounts.ts";
import {
  AIRoutingState,
  AIRoutingStateError,
  type AIAcquiredReservation,
  type AIRoutingSummary,
} from "./routing-service.ts";

export {
  AIRoutingState,
  AIRoutingStateError,
  type AIAcquiredReservation,
  type AIRoutingAcquireInput,
  type AIRoutingEvaluateInput,
  type AIRoutingSummary,
} from "./routing-service.ts";

const ManagedAccountVaultErrorCode = Schema.Literals([
  "account_not_found",
  "needs_reauthentication",
  "invalid_credential",
  "refresh_transient",
  "interrupted",
  "storage_unavailable",
]);

export class ManagedAccountVaultError extends Schema.TaggedErrorClass<ManagedAccountVaultError>()(
  "ManagedAccountVaultError",
  { code: ManagedAccountVaultErrorCode },
) {}

export class ManagedAccountVault extends Context.Service<
  ManagedAccountVault,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<ManagedAccountSummary>,
      ManagedAccountVaultError
    >;
    readonly addFromOAuth: (
      label: string,
      credentials: OAuthCredentials,
    ) => Effect.Effect<string, ManagedAccountVaultError>;
    readonly getFreshCredential: (
      id: string,
    ) => Effect.Effect<FreshCredential, ManagedAccountVaultError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<boolean, ManagedAccountVaultError>;
    readonly markNeedsReauth: (
      id: string,
      rejectedAccessToken?: string,
    ) => Effect.Effect<boolean, ManagedAccountVaultError>;
  }
>()("agentos/ai-gateway/ManagedAccountVault") {}
