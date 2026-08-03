import { createHash, createPublicKey, createSign } from "node:crypto";
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
  readonly check: Effect.Effect<void, GitHubBrokerError>;
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
  readonly readinessRefreshMillis?: number;
}

const InstallationTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
});
const InstallationReadinessResponse = Schema.Struct({
  id: Schema.Number,
  account: Schema.Struct({ login: Schema.String }),
  suspended_at: Schema.NullOr(Schema.String),
});

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1_024;
const TOKEN_MAX_BYTES = 16 * 1_024;
const PRIVATE_KEY_MAX_BYTES = 1024 * 1_024;
const DEFAULT_REFRESH_BEFORE_MILLIS = 5 * 60_000;
const DEFAULT_READINESS_REFRESH_MILLIS = 60_000;

export const makeGitHubInstallationTokenProvider = Effect.fn(
  "agentos.githubBroker.makeInstallationTokenProvider",
)(function*(options: TokenProviderOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const http = yield* GitHubProviderHttp;
  yield* validatePositiveInteger(options.appId);
  yield* validatePositiveInteger(options.installationId);
  const startupKey = yield* loadPrivateKey(fileSystem, options.privateKeyFile);
  yield* createAppJwt(
    options.appId,
    startupKey,
    Math.floor((yield* (options.now ?? Clock.currentTimeMillis)) / 1_000),
  );
  const cache = yield* Ref.make(
    new Map<string, GitHubInstallationTokenLease>(),
  );
  const mintLock = yield* Semaphore.make(1);
  const readinessLock = yield* Semaphore.make(1);
  const lastRemoteReadiness = yield* Ref.make<{
    readonly checkedAtMillis: number;
    readonly keyIdentity: string;
  } | null>(null);
  const now = options.now ?? Clock.currentTimeMillis;
  const refreshBeforeMillis = options.refreshBeforeMillis ??
    DEFAULT_REFRESH_BEFORE_MILLIS;
  const readinessRefreshMillis = options.readinessRefreshMillis ??
    DEFAULT_READINESS_REFRESH_MILLIS;
  if (
    !Number.isSafeInteger(refreshBeforeMillis) || refreshBeforeMillis <= 0 ||
    !Number.isSafeInteger(readinessRefreshMillis) ||
    readinessRefreshMillis <= 0
  ) {
    return yield* githubBrokerError("invalid_configuration");
  }

  const mint = Effect.fn("agentos.githubBroker.mintInstallationToken")(
    function*(scope: GitHubInstallationTokenScope) {
      yield* validateScope(scope, options.installationOwner);
      yield* validatePositiveInteger(options.appId);
      yield* validatePositiveInteger(options.installationId);
      const currentTime = yield* now;
      const privateKey = yield* loadPrivateKey(
        fileSystem,
        options.privateKeyFile,
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

  const check = Effect.fn("agentos.githubBroker.checkInstallation")(
    function*() {
      const currentTime = yield* now;
      const privateKey = yield* loadPrivateKey(
        fileSystem,
        options.privateKeyFile,
      );
      const jwt = yield* createAppJwt(
        options.appId,
        privateKey,
        Math.floor(currentTime / 1_000),
      );
      const keyIdentity = yield* privateKeyIdentity(privateKey);
      yield* readinessLock.withPermit(Effect.gen(function*() {
        const lastReady = yield* Ref.get(lastRemoteReadiness);
        if (
          lastReady !== null &&
          lastReady.keyIdentity === keyIdentity &&
          currentTime >= lastReady.checkedAtMillis &&
          currentTime - lastReady.checkedAtMillis < readinessRefreshMillis
        ) {
          return;
        }
        const endpoint = yield* installationEndpoint(options);
        const request = yield* Effect.try({
          try: () =>
            new Request(endpoint.toString(), {
              method: "GET",
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${jwt}`,
                "user-agent": "agentos-github-broker",
                "x-github-api-version": "2022-11-28",
              },
            }),
          catch: () => githubBrokerError("invalid_configuration"),
        });
        const response = yield* http.execute(request);
        const source = yield* readBoundedResponse(response);
        if (!response.ok) {
          return yield* githubBrokerError("credential_unavailable");
        }
        const installation = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(InstallationReadinessResponse),
        )(source).pipe(
          Effect.mapError(() => githubBrokerError("credential_unavailable")),
        );
        if (
          installation.id !== Number(options.installationId) ||
          installation.suspended_at !== null ||
          (options.installationOwner !== undefined &&
            installation.account.login.toLowerCase() !==
              options.installationOwner.toLowerCase())
        ) {
          return yield* githubBrokerError("credential_unavailable");
        }
        yield* Ref.set(lastRemoteReadiness, {
          checkedAtMillis: currentTime,
          keyIdentity,
        });
      }));
    },
  )();

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
    check,
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

function privateKeyIdentity(privateKey: string) {
  return Effect.try({
    try: () => {
      const publicKey = createPublicKey(privateKey).export({
        type: "spki",
        format: "der",
      });
      return createHash("sha256").update(publicKey).digest("hex");
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
  const number = Number(value);
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(number)
    ? Effect.void
    : Effect.fail(githubBrokerError("invalid_configuration"));
}

function loadPrivateKey(
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  return Effect.gen(function*() {
    const metadata = yield* fileSystem.stat(path).pipe(
      Effect.mapError(() => githubBrokerError("credential_unavailable")),
    );
    if (
      metadata.type !== "File" ||
      metadata.size <= FileSystem.Size(0) ||
      metadata.size > FileSystem.Size(PRIVATE_KEY_MAX_BYTES) ||
      (metadata.mode & 0o022) !== 0
    ) {
      return yield* githubBrokerError("credential_unavailable");
    }
    return yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(() => githubBrokerError("credential_unavailable")),
    );
  });
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

function installationEndpoint(options: TokenProviderOptions) {
  return Effect.try({
    try: () =>
      new URL(
        `/app/installations/${options.installationId}`,
        `${options.apiUrl.replace(/\/+$/, "")}/`,
      ),
    catch: () => githubBrokerError("invalid_configuration"),
  });
}
