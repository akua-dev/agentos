import { Effect, Layer } from "effect";

import type {
  AccountVault,
  AccountVaultError,
} from "./effect-accounts.ts";
import {
  ManagedAccountVault,
  ManagedAccountVaultError,
} from "./state.ts";

export function makeEffectManagedAccountVaultLayer(vault: AccountVault) {
  return Layer.succeed(ManagedAccountVault, ManagedAccountVault.of({
    list: vault.list.pipe(Effect.mapError(managedError)),
    addFromOAuth: (label, credentials) =>
      vault.addFromOAuth(label, credentials).pipe(
        Effect.mapError(managedError),
      ),
    getFreshCredential: (id) =>
      vault.getFreshCredential(id).pipe(Effect.mapError(managedError)),
    remove: (id) => vault.remove(id).pipe(Effect.mapError(managedError)),
    markNeedsReauth: (id, rejectedAccessToken) =>
      vault.markNeedsReauth(id, rejectedAccessToken).pipe(
        Effect.mapError(managedError),
      ),
  }));
}

function managedError(cause: AccountVaultError) {
  return ManagedAccountVaultError.make({ code: cause.code });
}
