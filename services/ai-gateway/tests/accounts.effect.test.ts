import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
} from "effect";

import {
  AccountVaultError,
  extractCodexAccountId,
  makeAccountVault,
  makeAccountVaultStore,
} from "../src/effect-accounts.ts";
import {
  CodexOAuthError,
  type CodexOAuthRefreshClient,
} from "../src/codex-oauth-effect.ts";

const now = 100_000;
const platform = Layer.mergeAll(
  BunCryptoLayer,
  BunFileSystem.layer,
  BunPath.layer,
);

function accessToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function credentials(
  accountId: string,
  expires: number,
  refresh = "refresh-secret",
): OAuthCredentials {
  return { access: accessToken(accountId), refresh, expires };
}

function oauth(
  refresh: CodexOAuthRefreshClient["refresh"],
): CodexOAuthRefreshClient {
  return { refresh };
}

describe("Effect server-owned Codex account vault", () => {
  it.effect("uses opaque IDs and never exposes provider identity or tokens", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-accounts-",
      });
      const store = yield* makeAccountVaultStore(`${root}/accounts.json`);
      const vault = yield* makeAccountVault({
        store,
        oauth: oauth(() =>
          Effect.succeed(credentials("provider-a", now + 3_600_000))
        ),
        now: Effect.succeed(now),
      });
      const id = yield* vault.addFromOAuth(
        "  Team\nA  ",
        credentials("provider-a", now + 3_600_000),
      );
      const summaries = yield* vault.list;

      assert.match(id, /^codex-[a-f0-9]{12}$/);
      assert.deepStrictEqual(summaries, [{
        id,
        label: "Team A",
        expiresAt: now + 3_600_000,
        needsReauth: false,
      }]);
      assert.notInclude(JSON.stringify(summaries), "provider-a");
      assert.notInclude(JSON.stringify(summaries), "refresh-secret");
      assert.strictEqual(
        yield* extractCodexAccountId(
          credentials("provider-a", now).access,
        ),
        "provider-a",
      );
    }).pipe(Effect.provide(platform))));

  it.effect("serializes concurrent refresh and persists one rotation", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-refresh-",
      });
      const refreshes = yield* Ref.make(0);
      const store = yield* makeAccountVaultStore(`${root}/accounts.json`);
      const vault = yield* makeAccountVault({
        store,
        oauth: oauth(() =>
          Ref.update(refreshes, (value) => value + 1).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.as(
              credentials("provider-a", 1_000_000, "rotated-refresh"),
            ),
          )
        ),
        now: Effect.succeed(now),
      });
      const id = yield* vault.addFromOAuth(
        "A",
        credentials("provider-a", now + 1),
      );

      const values = yield* Effect.all([
        vault.getFreshCredential(id),
        vault.getFreshCredential(id),
      ], { concurrency: "unbounded" });

      assert.strictEqual(yield* Ref.get(refreshes), 1);
      assert.deepStrictEqual(values[0], values[1]);
      assert.strictEqual(values[0]?.accessToken, accessToken("provider-a"));
      assert.strictEqual(
        (yield* store.read).accounts[0]?.refreshToken,
        "rotated-refresh",
      );
    }).pipe(Effect.provide(platform))));

  it.effect("persists reauthentication after definitive or identity-changing refresh failures", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-reauth-",
      });
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly refresh: CodexOAuthRefreshClient["refresh"];
      }> = [
        {
          name: "identity-change",
          refresh: () =>
            Effect.succeed(credentials("provider-b", 1_000_000)),
        },
        {
          name: "invalid-grant",
          refresh: () =>
            Effect.fail(CodexOAuthError.make({ code: "invalid_grant" })),
        },
      ];

      for (const testCase of cases) {
        const store = yield* makeAccountVaultStore(
          `${root}/${testCase.name}.json`,
        );
        const vault = yield* makeAccountVault({
          store,
          oauth: oauth(testCase.refresh),
          now: Effect.succeed(now),
        });
        const id = yield* vault.addFromOAuth(
          "A",
          credentials("provider-a", now + 1),
        );
        const failure = yield* Effect.flip(vault.getFreshCredential(id));
        assert.instanceOf(failure, AccountVaultError);
        assert.strictEqual(failure.code, "needs_reauthentication");
        assert.deepStrictEqual(yield* vault.list, [{
          id,
          label: "A",
          expiresAt: now + 1,
          needsReauth: true,
        }]);
        assert.notInclude(String(failure), "provider-a");
        assert.notInclude(String(failure), "refresh-secret");
      }
    }).pipe(Effect.provide(platform))));

  it.effect("releases the durable lock when a refresh is interrupted", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-interrupt-",
      });
      const interrupted = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const store = yield* makeAccountVaultStore(`${root}/accounts.json`, {
        lockTimeoutMillis: 250,
      });
      const vault = yield* makeAccountVault({
        store,
        oauth: oauth(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          )
        ),
        now: Effect.succeed(now),
      });
      const id = yield* vault.addFromOAuth(
        "A",
        credentials("provider-a", now + 1),
      );
      const fiber = yield* Effect.forkChild(vault.getFreshCredential(id));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(yield* Ref.get(interrupted), true);
      assert.strictEqual(yield* vault.remove(id), true);
    }).pipe(Effect.provide(platform))));

  it.effect("does not let a stale rejected token invalidate a rotated login", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-token-race-",
      });
      const store = yield* makeAccountVaultStore(`${root}/accounts.json`);
      const vault = yield* makeAccountVault({
        store,
        oauth: oauth(() => Effect.die("unused")),
        now: Effect.succeed(now),
      });
      const original = credentials("provider-a", now + 3_600_000, "original");
      const rotated = {
        ...credentials("provider-a", now + 7_200_000, "rotated"),
        access: accessToken("provider-a").replace("header.", "rotated."),
      };
      const id = yield* vault.addFromOAuth("A", original);
      yield* vault.addFromOAuth("A", rotated);

      assert.strictEqual(
        yield* vault.markNeedsReauth(id, original.access),
        false,
      );
      assert.strictEqual((yield* vault.list)[0]?.needsReauth, false);
      assert.strictEqual(
        yield* vault.markNeedsReauth(id, rotated.access),
        true,
      );
      assert.strictEqual((yield* vault.list)[0]?.needsReauth, true);
    }).pipe(Effect.provide(platform))));
});
