import { createSign } from "node:crypto";
import {
  Clock,
  Effect,
  FileSystem,
  Ref,
  Schema,
  Semaphore,
} from "effect";

import { GitHubProviderHttp } from "./http.ts";
import { type GitHubBrokerError, githubBrokerError } from "./types.ts";

export type GitHubInstallationPermission =
  | "actions"
  | "contents"
  | "issues"
  | "pull_requests";

export interface GitHubInstallationTokenScope {
  readonly owner: string;
  readonly repository: string;
  readonly permissions: Readonly<
    Partial<Record<GitHubInstallationPermission, "read" | "write">>
  >;
}

export interface GitHubInstallationTokenLease {
  readonly token: string;
  readonly expiresAtMillis: number;
}

export interface GitHubInstallationTokenProvider {
  readonly acquire: (
    scope: GitHubInstallationTokenScope,
  ) => Effect.Effect<GitHubInstallationTokenLease, GitHubBrokerError>;
  readonly invalidate: (
    scope: GitHubInstallationTokenScope,
  ) => Effect.Effect<void>;
}

export interface TokenProviderOptions {
  readonly apiUrl: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyFile: string;
  readonly installationOwner?: string;
  readonly now?: Effect.Effect<number>;
  readonly refreshBeforeMillis?: number;
}

const InstallationTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
});

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1_024;
const TOKEN_MAX_BYTES = 16 * 1_024;
const PRIVATE_KEY_MAX_BYTES = 1024 * 1_024;
const DEFAULT_REFRESH_BEFORE_MILLIS = 5 * 60_000;

export const makeGitHubInstallationTokenProvider = Effect.fn(
  "agentos.githubBroker.makeInstallationTokenProvider",
)(function*(options: TokenProviderOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const http = yield* GitHubProviderHttp;
  yield* validatePositiveInteger(options.appId);
  yield* validatePositiveInteger(options.installationId);
  const privateKeyMetadata = yield* fileSystem.stat(options.privateKeyFile).pipe(
    Effect.mapError(() => githubBrokerError("credential_unavailable")),
  );
  if (
    privateKeyMetadata.type !== "File" ||
    privateKeyMetadata.size <= FileSystem.Size(0) ||
    privateKeyMetadata.size > FileSystem.Size(PRIVATE_KEY_MAX_BYTES) ||
    (privateKeyMetadata.mode & 0o022) !== 0
  ) {
    return yield* githubBrokerError("credential_unavailable");
  }
  const startupKey = yield* fileSystem
    .readFileString(options.privateKeyFile)
    .pipe(
      Effect.mapError(() => githubBrokerError("credential_unavailable")),
    );
  yield* createAppJwt(
    options.appId,
    startupKey,
    Math.floor((yield* (options.now ?? Clock.currentTimeMillis)) / 1_000),
  );
  const cache = yield* Ref.make(
    new Map<string, GitHubInstallationTokenLease>(),
  );
  const mintLock = yield* Semaphore.make(1);
  const now = options.now ?? Clock.currentTimeMillis;
  const refreshBeforeMillis = options.refreshBeforeMillis ??
    DEFAULT_REFRESH_BEFORE_MILLIS;

  const mint = Effect.fn("agentos.githubBroker.mintInstallationToken")(
    function*(scope: GitHubInstallationTokenScope) {
      yield* validateScope(scope, options.installationOwner);
      yield* validatePositiveInteger(options.appId);
      yield* validatePositiveInteger(options.installationId);
      const currentTime = yield* now;
      const privateKey = yield* fileSystem
        .readFileString(options.privateKeyFile)
        .pipe(
          Effect.mapError(() => githubBrokerError("credential_unavailable")),
        );
      const jwt = yield* createAppJwt(
        options.appId,
        privateKey,
        Math.floor(currentTime / 1_000),
      );
      const endpoint = yield* installationTokenEndpoint(options);
      const request = yield* Effect.try({
        try: () =>
          new Request(endpoint.toString(), {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${jwt}`,
              "content-type": "application/json",
              "user-agent": "agentos-github-broker",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({
              repositories: [scope.repository],
              permissions: scope.permissions,
            }),
          }),
        catch: () => githubBrokerError("invalid_configuration"),
      });
      const response = yield* http.execute(request);
      const source = yield* readBoundedResponse(response);
      if (!response.ok) {
        return yield* githubBrokerError("credential_unavailable");
      }
      const body = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(InstallationTokenResponse),
      )(source).pipe(
        Effect.mapError(() => githubBrokerError("credential_unavailable")),
      );
      if (
        body.token.length === 0 ||
        Buffer.byteLength(body.token) > TOKEN_MAX_BYTES ||
        /\s/.test(body.token)
      ) {
        return yield* githubBrokerError("credential_unavailable");
      }
      const expiresAtMillis = Date.parse(body.expires_at);
      if (
        !Number.isSafeInteger(expiresAtMillis) ||
        expiresAtMillis <= currentTime + 60_000
      ) {
        return yield* githubBrokerError("credential_unavailable");
      }
      return { token: body.token, expiresAtMillis };
    },
  );

  const acquire = Effect.fn("agentos.githubBroker.acquireInstallationToken")(
    function*(scope: GitHubInstallationTokenScope) {
      yield* validateScope(scope, options.installationOwner);
      const key = scopeKey(scope);
      const currentTime = yield* now;
      const cached = (yield* Ref.get(cache)).get(key);
      if (
        cached !== undefined &&
        cached.expiresAtMillis - refreshBeforeMillis > currentTime
      ) {
        return cached;
      }
      return yield* mintLock.withPermit(Effect.gen(function*() {
        const lockedTime = yield* now;
        const lockedCached = (yield* Ref.get(cache)).get(key);
        if (
          lockedCached !== undefined &&
          lockedCached.expiresAtMillis - refreshBeforeMillis > lockedTime
        ) {
          return lockedCached;
        }
        const lease = yield* mint(scope);
        yield* Ref.update(cache, (current) =>
          new Map(current).set(key, lease)
        );
        return lease;
      }));
    },
  );

  return {
    acquire,
    invalidate: (scope) =>
      Ref.update(cache, (current) => {
        const next = new Map(current);
        next.delete(scopeKey(scope));
        return next;
      }),
  } satisfies GitHubInstallationTokenProvider;
});

function readBoundedResponse(response: Response) {
  return Effect.gen(function*() {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > TOKEN_RESPONSE_MAX_BYTES) {
      return yield* githubBrokerError("credential_unavailable");
    }
    const bytes = new Uint8Array(yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: () => githubBrokerError("credential_unavailable"),
    }));
    if (bytes.byteLength > TOKEN_RESPONSE_MAX_BYTES) {
      return yield* githubBrokerError("credential_unavailable");
    }
    return new TextDecoder().decode(bytes);
  });
}

function createAppJwt(appId: string, privateKey: string, nowSeconds: number) {
  return Effect.try({
    try: () => {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: appId,
      })}`;
      const signer = createSign("RSA-SHA256");
      signer.update(unsigned);
      return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
    },
    catch: () => githubBrokerError("credential_unavailable"),
  });
}

function validateScope(
  scope: GitHubInstallationTokenScope,
  installationOwner: string | undefined,
) {
  const valid =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(scope.owner) &&
    scope.owner.length <= 39 &&
    /^[a-z0-9._-]+$/.test(scope.repository) &&
    scope.repository.length <= 100 &&
    Object.keys(scope.permissions).length === 1 &&
    Object.values(scope.permissions).every((value) =>
      value === "read" || value === "write"
    ) &&
    (installationOwner === undefined ||
      scope.owner === installationOwner.toLowerCase());
  return valid ? Effect.void : Effect.fail(githubBrokerError("invalid_grant"));
}

function scopeKey(scope: GitHubInstallationTokenScope): string {
  return JSON.stringify([
    scope.owner,
    scope.repository,
    Object.entries(scope.permissions).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  ]);
}

function validatePositiveInteger(value: string) {
  return /^[1-9][0-9]*$/.test(value)
    ? Effect.void
    : Effect.fail(githubBrokerError("invalid_configuration"));
}

function installationTokenEndpoint(options: TokenProviderOptions) {
  return Effect.try({
    try: () =>
      new URL(
        `/app/installations/${options.installationId}/access_tokens`,
        `${options.apiUrl.replace(/\/+$/, "")}/`,
      ),
    catch: () => githubBrokerError("invalid_configuration"),
  });
}
