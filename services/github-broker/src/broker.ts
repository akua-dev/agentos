import {
  PROVIDER_AUTHORIZATION_GRANT_HEADERS,
  ProviderAuthorizationError,
  decodeProviderAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";
import { Clock, Effect } from "effect";

import { GitHubProviderHttp } from "./http.ts";
import {
  type GitHubInstallationTokenProvider,
  type GitHubInstallationTokenScope,
} from "./token.ts";
import { GitHubBrokerError, githubBrokerError } from "./types.ts";

export interface GitHubBrokerOptions {
  readonly tokens: GitHubInstallationTokenProvider;
  readonly apiUrl: string;
  readonly gitUrl: string;
  readonly now?: Effect.Effect<number>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const GRANT_HEADERS = new Set<string>(PROVIDER_AUTHORIZATION_GRANT_HEADERS);
const GRAPHQL_AUTHORIZATION_BODY_MAX_BYTES = 256 * 1_024;

export type GitHubBrokerHandler = (
  request: Request,
) => Effect.Effect<Response, ProviderAuthorizationError | GitHubBrokerError>;

export const makeGitHubBrokerHandler = Effect.fn(
  "agentos.githubBroker.makeHandler",
)(function*(options: GitHubBrokerOptions) {
  const http = yield* GitHubProviderHttp;
  const now = options.now ?? Clock.currentTimeMillis;

  const handler: GitHubBrokerHandler = Effect.fn(
    "agentos.githubBroker.forward",
  )(function*(request: Request) {
    const url = yield* Effect.try({
      try: () => new URL(request.url),
      catch: () => githubBrokerError("unsupported_route"),
    });
    const body = url.pathname === "/api/graphql"
      ? yield* readBoundedAuthorizationBody(request)
      : undefined;
    const currentTime = yield* now;
    const grant = yield* decodeProviderAuthorizationGrantHeaders(
      request.headers,
      {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        nowMillis: currentTime,
        body,
      },
    );
    if (
      grant.credentialDomain !== "github" ||
      grant.resource.kind !== "github_repository"
    ) {
      return yield* githubBrokerError("invalid_grant");
    }
    const scope = yield* tokenScopeForGrant(grant);
    const upstreamUrl = yield* resolveUpstreamUrl(
      url,
      options.apiUrl,
      options.gitUrl,
    );
    const lease = yield* options.tokens.acquire(scope);
    const headers = upstreamHeaders(request.headers);
    headers.set(
      "authorization",
      isGitSmartPath(url.pathname)
        ? `Basic ${Buffer.from(`x-access-token:${lease.token}`).toString("base64")}`
        : `Bearer ${lease.token}`,
    );
    const upstreamRequest = yield* Effect.try({
      try: () => {
        const init: RequestInit & { readonly duplex: "half" } = {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
          redirect: "manual",
          signal: request.signal,
          duplex: "half",
        };
        return new Request(upstreamUrl.toString(), init);
      },
      catch: () => githubBrokerError("provider_unavailable"),
    });
    const upstream = yield* http.execute(upstreamRequest);
    if (upstream.status === 401) {
      yield* options.tokens.invalidate(scope);
    }
    return copyProviderResponse(upstream);
  });
  return handler;
});

export function handleGitHubBrokerRequest(
  handler: GitHubBrokerHandler,
  request: Request,
) {
  return handler(request).pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(error))),
  );
}

export function serveGitHubBrokerRequest(
  handler: GitHubBrokerHandler,
  request: Request,
) {
  return Effect.gen(function*() {
    const url = yield* Effect.try({
      try: () => new URL(request.url),
      catch: () => githubBrokerError("unsupported_route"),
    });
    if (
      request.method === "GET" &&
      (url.pathname === "/livez" || url.pathname === "/readyz")
    ) {
      return Response.json({ status: "ready" });
    }
    return yield* handleGitHubBrokerRequest(handler, request);
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(Response.json({ error: "broker_unavailable" }, {
        status: 503,
      }))
    ),
  );
}

function tokenScopeForGrant(
  grant: ProviderAuthorizationGrantV1,
): Effect.Effect<GitHubInstallationTokenScope, GitHubBrokerError> {
  if (grant.resource.kind !== "github_repository") {
    return Effect.fail(githubBrokerError("invalid_grant"));
  }
  const permissions: GitHubInstallationTokenScope["permissions"] | undefined =
    (() => {
    switch (grant.capability) {
      case "github.actions.dispatch":
        return { actions: "write" };
      case "github.actions.read":
        return { actions: "read" };
      case "github.contents.write":
        return { contents: "write" };
      case "github.issue.read":
        return { issues: "read" };
      case "github.issue.write":
        return { issues: "write" };
      case "github.pull_request.read":
        return { pull_requests: "read" };
      case "github.pull_request.write":
        return { pull_requests: "write" };
      case "github.repository.read":
        return { contents: "read" };
      default:
        return undefined;
    }
  })();
  return permissions === undefined
    ? Effect.fail(githubBrokerError("invalid_grant"))
    : Effect.succeed({
      owner: grant.resource.owner,
      repository: grant.resource.repository,
      permissions,
    });
}

function resolveUpstreamUrl(
  request: URL,
  apiUrl: string,
  gitUrl: string,
) {
  const route = (() => {
    if (request.pathname === "/api/graphql") {
      return { base: apiUrl, path: "/graphql" };
    }
    if (request.pathname.startsWith("/api/v3/")) {
      return { base: apiUrl, path: request.pathname.slice("/api/v3".length) };
    }
    if (isGitSmartPath(request.pathname)) {
      return { base: gitUrl, path: request.pathname };
    }
    return undefined;
  })();
  if (route === undefined) {
    return Effect.fail(githubBrokerError("unsupported_route"));
  }
  return Effect.try({
    try: () => {
      const upstream = new URL(
        route.path,
        `${route.base.replace(/\/+$/, "")}/`,
      );
      upstream.search = request.search;
      return upstream;
    },
    catch: () => githubBrokerError("invalid_configuration"),
  });
}

function readBoundedAuthorizationBody(request: Request) {
  return Effect.gen(function*() {
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      Number(declared) > GRAPHQL_AUTHORIZATION_BODY_MAX_BYTES
    ) {
      return yield* githubBrokerError("unsupported_route");
    }
    const bytes = new Uint8Array(yield* Effect.tryPromise({
      try: () => request.clone().arrayBuffer(),
      catch: () => githubBrokerError("unsupported_route"),
    }));
    if (bytes.byteLength > GRAPHQL_AUTHORIZATION_BODY_MAX_BYTES) {
      return yield* githubBrokerError("unsupported_route");
    }
    return new TextDecoder().decode(bytes);
  });
}

function isGitSmartPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(
    path,
  );
}

function upstreamHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (
      HOP_BY_HOP_HEADERS.has(name) || name === "authorization" ||
      name.startsWith("x-agentos-") ||
      GRANT_HEADERS.has(name)
    ) continue;
    headers.set(name, value);
  }
  return headers;
}

function copyProviderResponse(response: Response): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name)) headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProviderAuthorizationError) {
    const status = [
      "grant_route_mismatch",
      "invalid_request",
      "policy_denied",
      "resource_mismatch",
      "unsupported_route",
    ]
        .includes(error.code)
      ? 403
      : 401;
    return Response.json(
      { error: status === 401 ? "unauthorized" : "forbidden" },
      { status },
    );
  }
  if (error instanceof GitHubBrokerError) {
    if (error.code === "invalid_grant" || error.code === "unsupported_route") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return Response.json(
      {
        error: error.code === "provider_unavailable"
          ? "provider_unavailable"
          : "credential_unavailable",
      },
      { status: error.code === "provider_unavailable" ? 502 : 503 },
    );
  }
  return Response.json({ error: "broker_unavailable" }, { status: 503 });
}
