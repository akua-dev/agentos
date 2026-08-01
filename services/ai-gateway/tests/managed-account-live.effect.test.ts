import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AccountVaultError,
  type AccountVault,
} from "../src/effect-accounts.ts";
import { makeEffectManagedAccountVaultLayer } from "../src/managed-account-live.ts";
import {
  ManagedAccountVault,
  ManagedAccountVaultError,
} from "../src/state.ts";

const now = Date.UTC(2026, 7, 1);

function accountVault(
  getFreshCredential: AccountVault["getFreshCredential"],
): AccountVault {
  return {
    list: Effect.succeed([{
      id: "managed-a",
      label: "A",
      expiresAt: now + 60_000,
      needsReauth: false,
    }]),
    addFromOAuth: () => Effect.succeed("managed-a"),
    getFreshCredential,
    remove: () => Effect.succeed(true),
    markNeedsReauth: () => Effect.succeed(true),
  };
}

describe("Effect managed-account live layer", () => {
  it.effect("provides the production vault without a Promise bridge", () =>
    Effect.gen(function*() {
      const layer = makeEffectManagedAccountVaultLayer(accountVault(() =>
        Effect.succeed({
          providerAccountId: "provider-a",
          accessToken: "provider-secret",
          expiresAt: now + 60_000,
        })
      ));
      const result = yield* Effect.gen(function*() {
        const vault = yield* ManagedAccountVault;
        return {
          accounts: yield* vault.list,
          credential: yield* vault.getFreshCredential("managed-a"),
        };
      }).pipe(Effect.provide(layer));

      assert.strictEqual(result.accounts[0]?.id, "managed-a");
      assert.strictEqual(result.credential.providerAccountId, "provider-a");
    }));

  it.effect("maps bounded account failures without retaining secrets", () =>
    Effect.gen(function*() {
      const codes: ReadonlyArray<AccountVaultError["code"]> = [
        "account_not_found",
        "needs_reauthentication",
        "invalid_credential",
        "refresh_transient",
        "storage_unavailable",
      ];
      for (const code of codes) {
        const layer = makeEffectManagedAccountVaultLayer(accountVault(() =>
          Effect.fail(AccountVaultError.make({ code }))
        ));
        const failure = yield* Effect.gen(function*() {
          const vault = yield* ManagedAccountVault;
          return yield* vault.getFreshCredential("provider-secret");
        }).pipe(Effect.provide(layer), Effect.flip);
        assert.instanceOf(failure, ManagedAccountVaultError);
        assert.strictEqual(failure.code, code);
        assert.notInclude(String(failure), "provider-secret");
      }
    }));
});
