import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { assert, describe, it } from "@effect/vitest";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem, Ref } from "effect";

import { GitHubProviderHttp } from "../src/http.ts";
import {
  makeGitHubInstallationTokenProvider,
  type GitHubInstallationTokenScope,
} from "../src/token.ts";
import { githubBrokerError } from "../src/types.ts";

const scope: GitHubInstallationTokenScope = {
  owner: "akua-dev",
  repository: "agentos",
  permissions: { issues: "write" },
};

function privateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
}

describe("GitHub installation-token provider", () => {
  it.effect("mints one exact repository token for concurrent requests and refreshes before expiry", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-broker-",
      });
      const keyFile = `${directory}/private-key.pem`;
      yield* fileSystem.writeFileString(keyFile, privateKey(), { mode: 0o600 });
      const now = yield* Ref.make(Date.parse("2026-08-01T12:00:00Z"));
      const mints = yield* Ref.make(0);
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly url: string;
        readonly body: string;
        readonly authorization: string | null;
      }>>([]);
      const http = GitHubProviderHttp.of({
        execute: Effect.fn("test.githubToken.http")(function*(request) {
          const mint = yield* Ref.updateAndGet(mints, (value) => value + 1);
          const body = yield* Effect.tryPromise({
            try: () => request.text(),
            catch: () => githubBrokerError("provider_unavailable"),
          });
          yield* Ref.update(requests, (current) => [
            ...current,
            {
              url: request.url,
              body,
              authorization: request.headers.get("authorization"),
            },
          ]);
          const currentTime = yield* Ref.get(now);
          return Response.json({
            token: `ghs_token_${mint}`,
            expires_at: new Date(currentTime + 60 * 60_000).toISOString(),
          });
        }),
      });
      const provider = yield* makeGitHubInstallationTokenProvider({
        apiUrl: "https://api.github.test",
        appId: "123",
        installationId: "456",
        privateKeyFile: keyFile,
        now: Ref.get(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const first = yield* Effect.all([
        provider.acquire(scope),
        provider.acquire(scope),
        provider.acquire(scope),
      ], { concurrency: "unbounded" });
      assert.deepStrictEqual(first.map(({ token }) => token), [
        "ghs_token_1",
        "ghs_token_1",
        "ghs_token_1",
      ]);
      assert.strictEqual(yield* Ref.get(mints), 1);
      const observed = yield* Ref.get(requests);
      assert.strictEqual(
        observed[0]?.url,
        "https://api.github.test/app/installations/456/access_tokens",
      );
      assert.strictEqual(
        observed[0]?.body,
        '{"repositories":["agentos"],"permissions":{"issues":"write"}}',
      );
      assert.match(observed[0]?.authorization ?? "", /^Bearer /);

      yield* Ref.update(now, (value) => value + 56 * 60_000);
      assert.strictEqual(
        (yield* provider.acquire(scope)).token,
        "ghs_token_2",
      );
      assert.strictEqual(yield* Ref.get(mints), 2);
    }).pipe(Effect.provide(BunFileSystem.layer))));

  it.effect("invalidates a cached token without retaining provider response secrets", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-broker-",
      });
      const keyFile = `${directory}/private-key.pem`;
      yield* fileSystem.writeFileString(keyFile, privateKey(), { mode: 0o600 });
      const calls = yield* Ref.make(0);
      const http = GitHubProviderHttp.of({
        execute: Effect.fn("test.githubToken.invalidateHttp")(function*() {
          const call = yield* Ref.updateAndGet(calls, (value) => value + 1);
          if (call === 1) {
            return Response.json({
              token: "ghs_first",
              expires_at: "2026-08-01T13:00:00Z",
            });
          }
          if (call === 2) {
            return Response.json(
              { message: "installation denied", token: "must-not-leak" },
              { status: 403 },
            );
          }
          return Response.json({
            token: "ghs_recovered",
            expires_at: "2026-08-01T13:00:00Z",
          });
        }),
      });
      const provider = yield* makeGitHubInstallationTokenProvider({
        apiUrl: "https://api.github.test",
        appId: "123",
        installationId: "456",
        privateKeyFile: keyFile,
        now: Effect.succeed(Date.parse("2026-08-01T12:00:00Z")),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      assert.strictEqual((yield* provider.acquire(scope)).token, "ghs_first");
      yield* provider.invalidate(scope);
      const failure = yield* provider.acquire(scope).pipe(Effect.flip);
      assert.strictEqual(failure.code, "credential_unavailable");
      assert.notInclude(JSON.stringify(failure), "must-not-leak");
      assert.strictEqual(
        (yield* provider.acquire(scope)).token,
        "ghs_recovered",
      );
    }).pipe(Effect.provide(BunFileSystem.layer))));
});
