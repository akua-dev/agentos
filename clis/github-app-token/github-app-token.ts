#!/usr/bin/env bun

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { createSign } from "node:crypto";
import {
  Clock,
  Config,
  ConfigProvider,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const help = `github-app-token

Mint one short-lived GitHub App installation token.

Usage:
  github-app-token [--scope-file PATH] [--token-file PATH]
                   [--metadata-file PATH]

Required environment:
  GITHUB_APP_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_APP_PRIVATE_KEY_FILE

Optional environment:
  GITHUB_API_URL  Defaults to https://api.github.com

Without --token-file, the token is written to standard output. A scope file may
reduce the installation token to selected repositories and permissions. Output
files are replaced atomically with mode 0600; metadata never contains the token.
`;

const PermissionLevelSchema = Schema.Literals(["read", "write"]);
export const InstallationTokenScopeSchema = Schema.Struct({
  repositories: Schema.optional(Schema.Array(Schema.String)),
  repository_ids: Schema.optional(Schema.Array(Schema.Number)),
  permissions: Schema.optional(
    Schema.Record(Schema.String, PermissionLevelSchema),
  ),
});
export type InstallationTokenScope =
  typeof InstallationTokenScopeSchema.Type;

const InstallationTokenResponseSchema = Schema.Struct({
  token: Schema.optional(Schema.Unknown),
  expires_at: Schema.optional(Schema.Unknown),
  permissions: Schema.optional(Schema.Unknown),
  repository_selection: Schema.optional(Schema.Unknown),
  repositories: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
});
const InstallationTokenResponseFromString = Schema.fromJsonString(
  InstallationTokenResponseSchema,
);
const ScopeFromString = Schema.fromJsonString(InstallationTokenScopeSchema);
const JsonFromString = Schema.fromJsonString(Schema.Unknown);
const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const RepositoryMetadataSchema = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
});
const isStringRecord = Schema.is(StringRecordSchema);
const isRepositoryMetadata = Schema.is(RepositoryMetadataSchema);

export interface InstallationTokenMetadata {
  readonly expires_at: string;
  readonly permissions?: Record<string, string>;
  readonly repository_selection?: string;
  readonly repositories?: Array<{ readonly id: number; readonly full_name: string }>;
}

const GitHubAppTokenErrorCodeSchema = Schema.Literals([
  "configuration",
  "filesystem",
  "jwt",
  "provider",
  "encoding",
]);

export class GitHubAppTokenError extends Schema.TaggedErrorClass<GitHubAppTokenError>()(
  "GitHubAppTokenError",
  {
    code: GitHubAppTokenErrorCodeSchema,
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = this.code === "configuration"
    ? 2
    : 1;
}

const tokenError = (
  code: typeof GitHubAppTokenErrorCodeSchema.Type,
  message: string,
  options?: { readonly status?: number; readonly cause?: unknown },
) => GitHubAppTokenError.make({ code, message, ...options });

export class GitHubAppJwtSigner extends Context.Service<
  GitHubAppJwtSigner,
  {
    readonly sign: (
      appId: string,
      privateKey: string,
      nowSeconds: number,
    ) => Effect.Effect<string, GitHubAppTokenError>;
  }
>()("agentos/github-app-token/JwtSigner") {}

export const GitHubAppJwtSignerLive = Layer.succeed(
  GitHubAppJwtSigner,
  GitHubAppJwtSigner.of({
    sign: (appId, privateKey, nowSeconds) =>
      Effect.try({
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
        catch: (cause) =>
          tokenError("jwt", "Could not sign the GitHub App JWT", { cause }),
      }),
  }),
);

export interface GitHubTokenHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly scope: InstallationTokenScope | undefined;
}

export interface GitHubTokenHttpResponse {
  readonly status: number;
  readonly body: string;
}

export class GitHubTokenHttp extends Context.Service<
  GitHubTokenHttp,
  {
    readonly execute: (
      request: GitHubTokenHttpRequest,
    ) => Effect.Effect<GitHubTokenHttpResponse, GitHubAppTokenError>;
  }
>()("agentos/github-app-token/Http") {}

export const GitHubTokenHttpLive = Layer.effect(
  GitHubTokenHttp,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    return GitHubTokenHttp.of({
      execute: Effect.fn("agentos.githubAppToken.http")(function*(input) {
        let request = HttpClientRequest.post(input.url).pipe(
          HttpClientRequest.setHeaders(input.headers),
        );
        if (input.scope !== undefined) {
          request = yield* HttpClientRequest.bodyJson(request, input.scope).pipe(
            Effect.mapError((cause) =>
              tokenError("encoding", "Could not encode the GitHub token scope", {
                cause,
              })
            ),
          );
        }
        const response = yield* client.execute(request).pipe(
          Effect.mapError((cause) =>
            tokenError("provider", "GitHub token request failed", { cause })
          ),
        );
        const body = yield* response.text.pipe(
          Effect.mapError((cause) =>
            tokenError("provider", "GitHub token response could not be read", {
              cause,
            })
          ),
        );
        if (new TextEncoder().encode(body).length > 64 * 1_024) {
          return yield* tokenError(
            "provider",
            "GitHub token response exceeds the supported size limit",
          );
        }
        return { status: response.status, body };
      }),
    });
  }),
);

export const createAppJwt = Effect.fn("agentos.githubAppToken.createJwt")(
  function*(appId: string, privateKey: string, nowSeconds?: number) {
    const signer = yield* GitHubAppJwtSigner;
    const current = nowSeconds ??
      Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    return yield* signer.sign(appId, privateKey, current);
  },
);

export const mintInstallationToken = Effect.fn(
  "agentos.githubAppToken.mint",
)(function*(options: {
  readonly apiUrl: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly scope?: InstallationTokenScope;
}) {
  yield* requiredPositiveInteger("GITHUB_APP_ID", options.appId);
  yield* requiredPositiveInteger(
    "GITHUB_APP_INSTALLATION_ID",
    options.installationId,
  );
  const jwt = yield* createAppJwt(options.appId, options.privateKey);
  const endpoint = yield* Effect.try({
    try: () => {
      const base = new URL(options.apiUrl);
      base.pathname = `${base.pathname.replace(/\/+$/, "")}/app/installations/${options.installationId}/access_tokens`;
      return base.toString();
    },
    catch: (cause) =>
      tokenError("configuration", "GITHUB_API_URL must be a valid URL", {
        cause,
      }),
  });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "User-Agent": "github-app-token",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.scope !== undefined) headers["Content-Type"] = "application/json";
  const http = yield* GitHubTokenHttp;
  const response = yield* http.execute({
    url: endpoint,
    headers,
    scope: options.scope,
  });
  const body = yield* Schema.decodeUnknownEffect(
    InstallationTokenResponseFromString,
  )(response.body).pipe(
    Effect.mapError((cause) =>
      tokenError("provider", "GitHub returned malformed token metadata", {
        cause,
      })
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const message = typeof body.message === "string"
      ? body.message
      : "provider request failed";
    return yield* tokenError(
      "provider",
      `${response.status}: ${message}`,
      { status: response.status },
    );
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    return yield* tokenError("provider", "GitHub returned no installation token");
  }
  if (typeof body.expires_at !== "string" || body.expires_at.length === 0) {
    return yield* tokenError(
      "provider",
      "GitHub returned no installation token expiry",
    );
  }
  const metadata: InstallationTokenMetadata = {
    expires_at: body.expires_at,
    ...(isStringRecord(body.permissions)
      ? { permissions: body.permissions }
      : {}),
    ...(typeof body.repository_selection === "string"
      ? { repository_selection: body.repository_selection }
      : {}),
    ...(Array.isArray(body.repositories)
      ? {
        repositories: body.repositories.filter(isRepositoryMetadata).map(
          ({ id, full_name }) => ({ id, full_name }),
        ),
      }
      : {}),
  };
  return { token: body.token, metadata };
});

export const readInstallationTokenScope = Effect.fn(
  "agentos.githubAppToken.readScope",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* fileSystem.readFileString(path).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(ScopeFromString)(source, {
        onExcessProperty: "error",
      })
    ),
    Effect.mapError((cause) =>
      tokenError("configuration", "cannot read scope file", { cause })
    ),
  );
  if (scope.repositories !== undefined && scope.repository_ids !== undefined) {
    return yield* tokenError(
      "configuration",
      "scope must use repositories or repository_ids, not both",
    );
  }
  if (
    scope.repositories !== undefined &&
    (scope.repositories.length === 0 ||
      scope.repositories.length > 500 ||
      scope.repositories.some((repository) => repository.length === 0))
  ) {
    return yield* tokenError(
      "configuration",
      "repositories must contain 1 to 500 repository names",
    );
  }
  if (
    scope.repository_ids !== undefined &&
    (scope.repository_ids.length === 0 ||
      scope.repository_ids.length > 500 ||
      scope.repository_ids.some((id) =>
        !Number.isSafeInteger(id) || id <= 0
      ))
  ) {
    return yield* tokenError(
      "configuration",
      "repository_ids must contain 1 to 500 positive integer IDs",
    );
  }
  if (
    scope.permissions !== undefined &&
    (Object.keys(scope.permissions).length === 0 ||
      Object.keys(scope.permissions).some((permission) => permission.length === 0))
  ) {
    return yield* tokenError(
      "configuration",
      "permissions must map permission names to read or write",
    );
  }
  if (
    scope.repositories === undefined &&
    scope.repository_ids === undefined &&
    scope.permissions === undefined
  ) {
    return yield* tokenError(
      "configuration",
      "scope must reduce repositories or permissions",
    );
  }
  return scope;
});

export const writePrivateFileAtomic = Effect.fn(
  "agentos.githubAppToken.atomicWrite",
)(function*(path: string, contents: string) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const suffix = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      tokenError("filesystem", "Could not create a private-file nonce", {
        cause,
      })
    ),
  );
  const temporary = paths.join(
    paths.dirname(path),
    `.${paths.basename(path)}.${suffix}.tmp`,
  );
  yield* Effect.gen(function*() {
    yield* fileSystem.writeFileString(temporary, contents, {
      flag: "wx",
      mode: 0o600,
    });
    yield* fileSystem.rename(temporary, path);
  }).pipe(
    Effect.mapError((cause) =>
      tokenError("filesystem", "Could not write a private token artifact", {
        cause,
      })
    ),
    Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(
      Effect.ignore,
    )),
  );
});

const CliConfig = Config.all({
  apiUrl: Config.url("GITHUB_API_URL").pipe(
    Config.withDefault(new URL("https://api.github.com")),
  ),
  appId: Config.string("GITHUB_APP_ID"),
  installationId: Config.string("GITHUB_APP_INSTALLATION_ID"),
  privateKeyFile: Config.string("GITHUB_APP_PRIVATE_KEY_FILE"),
});

const parseArguments = Effect.fn("agentos.githubAppToken.parseArguments")(
  function*(args: ReadonlyArray<string>) {
    const result: {
      scopeFile?: string;
      tokenFile?: string;
      metadataFile?: string;
    } = {};
    const options: Record<
      string,
      "scopeFile" | "tokenFile" | "metadataFile"
    > = {
      "--scope-file": "scopeFile",
      "--token-file": "tokenFile",
      "--metadata-file": "metadataFile",
    };
    for (let index = 0; index < args.length; index += 2) {
      const option = args[index];
      const value = args[index + 1];
      const key = option === undefined ? undefined : options[option];
      if (
        key === undefined ||
        value === undefined ||
        value.startsWith("--") ||
        result[key] !== undefined
      ) return yield* tokenError("configuration", help);
      result[key] = value;
    }
    return result;
  },
);

const requiredPositiveInteger = Effect.fn(
  "agentos.githubAppToken.positiveInteger",
)(function*(name: string, value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return yield* tokenError(
      "configuration",
      `${name} must be a positive integer`,
    );
  }
  return value;
});

const encodeMetadata = Effect.fn("agentos.githubAppToken.encodeMetadata")(
  function*(metadata: InstallationTokenMetadata) {
    yield* Schema.encodeEffect(JsonFromString)(metadata).pipe(
      Effect.mapError((cause) =>
        tokenError("encoding", "Could not encode token metadata", { cause })
      ),
    );
    return `${JSON.stringify(metadata, null, 2)}\n`;
  },
);

export const runGitHubAppToken = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  if (args.includes("--help") || args.includes("-h")) {
    yield* writeStdout(help);
    return;
  }
  const parsed = yield* parseArguments(args);
  const config = yield* CliConfig.pipe(
    Effect.mapError(() =>
      tokenError("configuration", "GITHUB_APP_ID must be a positive integer")
    ),
  );
  yield* requiredPositiveInteger("GITHUB_APP_ID", config.appId);
  yield* requiredPositiveInteger(
    "GITHUB_APP_INSTALLATION_ID",
    config.installationId,
  );
  const privateKey = yield* fileSystem.readFileString(
    config.privateKeyFile,
  ).pipe(
    Effect.mapError((cause) =>
      tokenError("filesystem", "Could not read the mounted private key", {
        cause,
      })
    ),
  );
  const scope = parsed.scopeFile === undefined
    ? undefined
    : yield* readInstallationTokenScope(parsed.scopeFile);
  const { token, metadata } = yield* mintInstallationToken({
    apiUrl: config.apiUrl.toString(),
    appId: config.appId,
    installationId: config.installationId,
    privateKey,
    scope,
  });
  if (parsed.metadataFile !== undefined) {
    yield* writePrivateFileAtomic(
      parsed.metadataFile,
      yield* encodeMetadata(metadata),
    );
  }
  if (parsed.tokenFile !== undefined) {
    yield* writePrivateFileAtomic(parsed.tokenFile, `${token}\n`);
  } else {
    yield* writeStdout(`${token}\n`);
  }
});

const writeStdout = Effect.fn("agentos.githubAppToken.stdout")(
  function*(contents: string) {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(contents).pipe(
      Stream.run(stdio.stdout()),
      Effect.mapError((cause) =>
        tokenError("filesystem", "Could not write command output", { cause })
      ),
    );
  },
);

const reportFailure = (error: GitHubAppTokenError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  const http = GitHubTokenHttpLive.pipe(Layer.provide(BunHttpClient.layer));
  const live = Layer.mergeAll(
    BunServices.layer,
    BunHttpClient.layer,
    GitHubAppJwtSignerLive,
    http,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(
    runGitHubAppToken.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(live),
    ),
    { disableErrorReporting: true },
  );
}
