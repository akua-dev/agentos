import { assert, describe, it } from "@effect/vitest";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { Effect } from "effect";

import {
  AccountNeedsReauthError,
  AccountNotFoundError,
  InvalidCodexTokenError,
  TokenRefreshTransientError,
  type AccountVault,
} from "../src/accounts.ts";
import {
  AIRoutingState,
  ManagedAccountVault,
  ManagedAccountVaultError,
  makeAIRoutingStateLayer,
  makeManagedAccountVaultLayer,
  type AIRoutingStateHandle,
} from "../src/state.ts";
import type { Candidate } from "../src/types.ts";

const now = Date.UTC(2026, 6, 19);

function accountVault(
  getFreshCredential: AccountVault["getFreshCredential"],
): AccountVault {
  return {
    list: () => Promise.resolve([{
      id: "managed-a",
      label: "A",
      expiresAt: now + 60_000,
      needsReauth: false,
    }]),
    addFromOAuth: (_label: string, _credentials: OAuthCredentials) =>
      Promise.resolve("managed-a"),
    getFreshCredential,
    remove: () => Promise.resolve(true),
    markNeedsReauth: () => Promise.resolve(true),
  };
}

const candidates: ReadonlyArray<Candidate> = [
  {
    accountId: "a",
    label: "A",
    needsReauth: false,
    usage: {
      accountId: "a",
      observedAt: now,
      stale: false,
      shortWindow: { usedPercent: 10, resetsAt: now + 3_600_000 },
      weeklyWindow: { usedPercent: 20, resetsAt: now + 24 * 3_600_000 },
    },
  },
  {
    accountId: "b",
    label: "B",
    needsReauth: false,
    usage: {
      accountId: "b",
      observedAt: now,
      stale: false,
      shortWindow: { usedPercent: 10, resetsAt: now + 3_600_000 },
      weeklyWindow: { usedPercent: 20, resetsAt: now + 48 * 3_600_000 },
    },
  },
];

describe("Effect AI Gateway state services", () => {
  it.effect("adapts account-vault work into typed interruptible Effects", () =>
    Effect.gen(function*() {
      let observedSignal: AbortSignal | undefined;
      const layer = makeManagedAccountVaultLayer(accountVault((_id, signal) => {
        observedSignal = signal;
        return Promise.resolve({
          providerAccountId: "provider-a",
          accessToken: "provider-secret",
          expiresAt: now + 60_000,
        });
      }));
      const result = yield* Effect.gen(function*() {
        const vault = yield* ManagedAccountVault;
        const accounts = yield* vault.list;
        const credential = yield* vault.getFreshCredential("managed-a");
        const marked = yield* vault.markNeedsReauth(
          "managed-a",
          credential.accessToken,
        );
        return { accounts, credential, marked };
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(result.accounts, [{
        id: "managed-a",
        label: "A",
        expiresAt: now + 60_000,
        needsReauth: false,
      }]);
      assert.deepStrictEqual(result.credential, {
        providerAccountId: "provider-a",
        accessToken: "provider-secret",
        expiresAt: now + 60_000,
      });
      assert.strictEqual(result.marked, true);
      assert.isDefined(observedSignal);
    }));

  it.effect("keeps account absence, reauthentication, invalid credentials, and transient refresh distinct", () =>
    Effect.gen(function*() {
      const cases = [
        {
          cause: new AccountNotFoundError("private-provider-account"),
          code: "account_not_found",
        },
        {
          cause: new AccountNeedsReauthError(),
          code: "needs_reauthentication",
        },
        {
          cause: new InvalidCodexTokenError(),
          code: "invalid_credential",
        },
        {
          cause: new TokenRefreshTransientError(),
          code: "refresh_transient",
        },
        {
          cause: new Error("private storage detail"),
          code: "storage_unavailable",
        },
      ];
      for (const candidate of cases) {
        const layer = makeManagedAccountVaultLayer(accountVault(() =>
          Promise.reject(candidate.cause)
        ));
        const failure = yield* Effect.flip(Effect.gen(function*() {
          const vault = yield* ManagedAccountVault;
          return yield* vault.getFreshCredential("managed-a");
        }).pipe(Effect.provide(layer)));
        assert.instanceOf(failure, ManagedAccountVaultError);
        assert.strictEqual(failure.code, candidate.code);
        assert.notInclude(String(failure), "private");
      }
    }));

  it.effect("scopes the durable routing adapter and preserves typed operations", () =>
    Effect.gen(function*() {
      let closeCalls = 0;
      const reservation = {
        accountId: "a",
        leaseToken: "lease-a",
        expiresAt: now + 60_000,
        decisionReason: "best_candidate",
      };
      const handle: AIRoutingStateHandle = {
        summary: () => Promise.resolve({
          activeReservations: 1,
          reservationsByAccount: { a: 1 },
          lastSelection: {
            observedAt: now,
            reason: "best_candidate",
            candidates: [{
              accountId: "a",
              eligible: true,
              freshness: "fresh",
            }],
          },
        }),
        acquire: () => Promise.resolve(reservation),
        evaluate: () => Promise.resolve({
          accountId: "a",
          reason: "best_candidate",
          candidates: [],
        }),
        renew: () => Promise.resolve(true),
        release: () => Promise.resolve(true),
        recordResponse: () => Promise.resolve(),
        close: () => {
          closeCalls += 1;
          return Promise.resolve();
        },
      };
      const layer = makeAIRoutingStateLayer(() => Promise.resolve(handle));
      yield* Effect.gen(function*() {
        const routing = yield* AIRoutingState;
        const acquired = yield* routing.acquire({
          candidates,
          now,
          sessionKey: "conversation-a",
        });
        assert.deepStrictEqual(acquired, reservation);
        assert.strictEqual(
          acquired === undefined
            ? false
            : yield* routing.renew(acquired.leaseToken, now + 30_000),
          true,
        );
        const summary = yield* routing.summary(now + 30_001);
        assert.strictEqual(summary.activeReservations, 1);
        assert.deepStrictEqual(summary.reservationsByAccount, { a: 1 });
        assert.strictEqual(summary.lastSelection?.observedAt, now);
        assert.strictEqual(summary.lastSelection?.reason, "best_candidate");
        assert.strictEqual(
          summary.lastSelection?.candidates.some((candidate) =>
            candidate.accountId === "a" && candidate.eligible
          ),
          true,
        );
        if (acquired !== undefined) {
          assert.strictEqual(yield* routing.release(acquired.leaseToken), true);
        }
        yield* routing.recordResponse("a", 200, new Headers(), now + 30_002);
        assert.strictEqual((yield* routing.evaluate({ candidates, now })).accountId, "a");
      }).pipe(Effect.provide(layer));
      assert.strictEqual(closeCalls, 1);
    }));
});
