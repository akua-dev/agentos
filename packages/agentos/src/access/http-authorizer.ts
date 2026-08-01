import { Clock, Effect, Encoding, Option, Result, Schema } from "effect";

import {
  AccessCapabilityIdSchema,
  AccessCeilingRefV1Schema,
  AccessProfileRefV1Schema,
  AccessRateClassIdSchema,
  AuthorizationResourceV1Schema,
  type AccessCapabilityId,
  type AuthorizationResourceV1,
  type AuthorizationSubjectV1,
} from "./contracts.ts";
import {
  ProviderPolicyDecisionError,
  ProviderPolicyDecisionPoint,
} from "./credential-delivery.ts";
import {
  WorkloadIdentityAuthenticator,
  WorkloadIdentityV1Schema,
  type WorkloadIdentityV1,
} from "./identity.ts";

const Uuid = WorkloadIdentityV1Schema.fields.agentId;
const KubernetesName = WorkloadIdentityV1Schema.fields.fleet;
const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const CorrelationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^corr_[0-9a-f]{32}$/)),
);
const DecisionRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^decision_[0-9a-f]{32}$/)),
);

export const PROVIDER_AUTHORIZATION_GRANT_MAX_TTL_MILLIS = 15_000;

export const ProviderAuthorizedIdentityV1Schema = Schema.Struct({
  agentId: Uuid,
  role: WorkloadIdentityV1Schema.fields.role,
  fleet: KubernetesName,
  domain: WorkloadIdentityV1Schema.fields.domain,
  assignmentId: Schema.NullOr(Uuid),
});

export const ProviderAuthorizationGrantV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  decisionRef: DecisionRef,
  expiresAtMillis: EpochMillis,
  credentialDomain: Schema.Literals(["github", "openai-responses"]),
  identity: ProviderAuthorizedIdentityV1Schema,
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  profile: AccessProfileRefV1Schema,
  ceiling: AccessCeilingRefV1Schema,
  rateClass: AccessRateClassIdSchema,
});

const ProviderAuthorizationErrorCode = Schema.Literals([
  "invalid_request",
  "unsupported_route",
  "invalid_grant",
  "grant_expired",
  "grant_route_mismatch",
  "assignment_mismatch",
  "resource_mismatch",
  "decision_mismatch",
  "policy_denied",
]);

export class ProviderAuthorizationError extends Schema.TaggedErrorClass<ProviderAuthorizationError>()(
  "ProviderAuthorizationError",
  { code: ProviderAuthorizationErrorCode },
) {}

export type ProviderAuthorizedIdentityV1 =
  typeof ProviderAuthorizedIdentityV1Schema.Type;
export type ProviderAuthorizationGrantV1 =
  typeof ProviderAuthorizationGrantV1Schema.Type;

export type ProviderAuthorizationRouteV1 =
  | {
    readonly credentialDomain: "openai-responses";
    readonly provider: "openai";
    readonly capability:
      | "openai.responses.create"
      | "openai.responses.compact";
    readonly resource: {
      readonly kind: "provider_service";
      readonly provider: "openai";
      readonly service: "responses";
    };
  }
  | {
    readonly credentialDomain: "github";
    readonly provider: "github";
    readonly capability:
      | "github.actions.dispatch"
      | "github.actions.read"
      | "github.contents.write"
      | "github.issue.read"
      | "github.issue.write"
      | "github.pull_request.read"
      | "github.pull_request.write"
      | "github.repository.read";
    readonly resource: {
      readonly kind: "github_repository";
      readonly owner: string;
      readonly repository: string;
    };
  };

export const PROVIDER_AUTHORIZATION_GRANT_HEADERS = Object.freeze([
  "x-agentos-authz-schema-version",
  "x-agentos-authz-correlation-id",
  "x-agentos-authz-decision-ref",
  "x-agentos-authz-expires-at-millis",
  "x-agentos-authz-credential-domain",
  "x-agentos-authz-agent-id",
  "x-agentos-authz-role",
  "x-agentos-authz-fleet",
  "x-agentos-authz-domain",
  "x-agentos-authz-assignment-id",
  "x-agentos-authz-capability",
  "x-agentos-authz-resource-kind",
  "x-agentos-authz-provider",
  "x-agentos-authz-service",
  "x-agentos-authz-resource-owner",
  "x-agentos-authz-resource-repository",
  "x-agentos-authz-resource-organization",
  "x-agentos-authz-resource-project-number",
  "x-agentos-authz-profile-id",
  "x-agentos-authz-profile-version",
  "x-agentos-authz-ceiling-id",
  "x-agentos-authz-ceiling-revision",
  "x-agentos-authz-rate-class",
]);

export function resolveProviderAuthorizationRoute(
  method: string,
  path: string,
  options: {
    readonly body?: string;
    readonly githubRepository?: string;
  } = {},
): Effect.Effect<ProviderAuthorizationRouteV1, ProviderAuthorizationError> {
  const normalizedMethod = method.toUpperCase();
  const parsed = parseRequestPath(path);
  if (parsed === null) {
    return Effect.fail(authorizerError("unsupported_route"));
  }
  if (normalizedMethod === "POST") {
    const compact = parsed.pathname === "/responses/compact" ||
      parsed.pathname === "/v1/responses/compact";
    const create = parsed.pathname === "/responses" ||
      parsed.pathname === "/v1/responses" ||
      parsed.pathname === "/codex/responses";
    if (compact || create) {
      return Effect.succeed({
        credentialDomain: "openai-responses",
        provider: "openai",
        capability: compact
          ? "openai.responses.compact"
          : "openai.responses.create",
        resource: {
          kind: "provider_service",
          provider: "openai",
          service: "responses",
        },
      });
    }
  }
  return resolveGitHubAuthorizationRoute(
    normalizedMethod,
    parsed,
    options,
  );
}

export function providerAuthorizationGrantHeaders(
  grant: ProviderAuthorizationGrantV1,
): Headers {
  const headers = new Headers({
    "x-agentos-authz-schema-version": "1",
    "x-agentos-authz-correlation-id": grant.correlationId,
    "x-agentos-authz-decision-ref": grant.decisionRef,
    "x-agentos-authz-expires-at-millis": String(grant.expiresAtMillis),
    "x-agentos-authz-credential-domain": grant.credentialDomain,
    "x-agentos-authz-agent-id": grant.identity.agentId,
    "x-agentos-authz-role": grant.identity.role,
    "x-agentos-authz-fleet": grant.identity.fleet,
    "x-agentos-authz-domain": grant.identity.domain,
    "x-agentos-authz-capability": grant.capability,
    "x-agentos-authz-resource-kind": grant.resource.kind,
    "x-agentos-authz-provider":
      providerForAuthorizationResource(grant.resource),
    "x-agentos-authz-service": serviceForAuthorizationResource(grant.resource),
    "x-agentos-authz-profile-id": grant.profile.profileId,
    "x-agentos-authz-profile-version": String(grant.profile.profileVersion),
    "x-agentos-authz-ceiling-id": grant.ceiling.ceilingId,
    "x-agentos-authz-ceiling-revision": String(grant.ceiling.revision),
    "x-agentos-authz-rate-class": grant.rateClass,
  });
  // Emit the optional field even when it is absent so ext-auth overwrites a
  // caller-supplied grant header instead of accidentally preserving it.
  headers.set(
    "x-agentos-authz-assignment-id",
    grant.identity.assignmentId ?? "",
  );
  headers.set(
    "x-agentos-authz-resource-owner",
    grant.resource.kind === "github_repository" ? grant.resource.owner : "",
  );
  headers.set(
    "x-agentos-authz-resource-repository",
    grant.resource.kind === "github_repository"
      ? grant.resource.repository
      : "",
  );
  headers.set(
    "x-agentos-authz-resource-organization",
    grant.resource.kind === "github_project"
      ? grant.resource.organization
      : "",
  );
  headers.set(
    "x-agentos-authz-resource-project-number",
    grant.resource.kind === "github_project"
      ? String(grant.resource.projectNumber)
      : "",
  );
  return headers;
}

export const decodeProviderAuthorizationGrantHeaders = Effect.fn(
  "agentos.providerAuthorization.decodeGrantHeaders",
)(function*(
  headers: Headers,
  request: {
    readonly method: string;
    readonly path: string;
    readonly nowMillis: number;
    readonly body?: string;
    readonly githubRepository?: string;
  },
) {
  const route = yield* resolveProviderAuthorizationRoute(
    request.method,
    request.path,
    {
      body: request.body,
      githubRepository: request.githubRepository,
    },
  );
  const raw = {
    schemaVersion: integerHeader(headers, "x-agentos-authz-schema-version"),
    correlationId: requiredHeader(headers, "x-agentos-authz-correlation-id"),
    decisionRef: requiredHeader(headers, "x-agentos-authz-decision-ref"),
    expiresAtMillis: integerHeader(
      headers,
      "x-agentos-authz-expires-at-millis",
    ),
    credentialDomain: requiredHeader(
      headers,
      "x-agentos-authz-credential-domain",
    ),
    identity: {
      agentId: requiredHeader(headers, "x-agentos-authz-agent-id"),
      role: requiredHeader(headers, "x-agentos-authz-role"),
      fleet: requiredHeader(headers, "x-agentos-authz-fleet"),
      domain: requiredHeader(headers, "x-agentos-authz-domain"),
      assignmentId: optionalHeader(
        headers,
        "x-agentos-authz-assignment-id",
      ) ?? null,
    },
    capability: requiredHeader(headers, "x-agentos-authz-capability"),
    resource: authorizationResourceFromHeaders(headers),
    profile: {
      profileId: requiredHeader(headers, "x-agentos-authz-profile-id"),
      profileVersion: integerHeader(
        headers,
        "x-agentos-authz-profile-version",
      ),
    },
    ceiling: {
      ceilingId: requiredHeader(headers, "x-agentos-authz-ceiling-id"),
      revision: integerHeader(headers, "x-agentos-authz-ceiling-revision"),
    },
    rateClass: requiredHeader(headers, "x-agentos-authz-rate-class"),
  };
  const grant = yield* Schema.decodeUnknownEffect(
    ProviderAuthorizationGrantV1Schema,
    { onExcessProperty: "error" },
  )(raw).pipe(
    Effect.mapError(() => authorizerError("invalid_grant")),
  );
  if (grant.expiresAtMillis <= request.nowMillis) {
    return yield* authorizerError("grant_expired");
  }
  if (
    grant.expiresAtMillis >
      request.nowMillis + PROVIDER_AUTHORIZATION_GRANT_MAX_TTL_MILLIS
  ) {
    return yield* authorizerError("invalid_grant");
  }
  if (
    grant.credentialDomain !== route.credentialDomain ||
    grant.capability !== route.capability ||
    grant.resource.kind !== route.resource.kind ||
    providerForAuthorizationResource(grant.resource) !== route.provider ||
    authorizationResourceKey(grant.resource) !==
      authorizationResourceKey(route.resource)
  ) {
    return yield* authorizerError("grant_route_mismatch");
  }
  if (grant.rateClass === "disabled") {
    return yield* authorizerError("policy_denied");
  }
  return grant;
});

export const createProviderAuthorizationHttpHandler = Effect.fn(
  "agentos.providerAuthorization.createHttpHandler",
)(function*(options: {
  readonly clock?: Effect.Effect<number>;
  readonly id: Effect.Effect<string, ProviderPolicyDecisionError>;
}) {
  const authenticator = yield* WorkloadIdentityAuthenticator;
  const decisionPoint = yield* ProviderPolicyDecisionPoint;
  const clock = options.clock ?? Clock.currentTimeMillis;
  const id = options.id;

  const authorize = Effect.fn("agentos.providerAuthorization.authorizeHttp")(
    function*(request: Request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/authorize") {
        return forbiddenResponse();
      }
      if (
        PROVIDER_AUTHORIZATION_GRANT_HEADERS.some((header) =>
          request.headers.has(header)
        )
      ) {
        return forbiddenResponse();
      }
      const bearerToken = bearerTokenFrom(request.headers);
      if (bearerToken === null) return unauthorizedResponse();
      const method = requiredHeader(
        request.headers,
        "x-agentos-original-method",
      );
      const path = requiredHeader(request.headers, "x-agentos-original-path");
      if (method === null || path === null) return forbiddenResponse();
      const body = yield* readBoundedAuthorizationBody(request);
      const githubRepository = optionalHeader(
        request.headers,
        "x-agentos-github-repository",
      );
      const routeResult = yield* Effect.result(
        resolveProviderAuthorizationRoute(method, path, {
          body,
          githubRepository,
        }),
      );
      if (routeResult._tag === "Failure") return forbiddenResponse();
      const route = routeResult.success;
      const requestedAssignmentId = optionalHeader(
        request.headers,
        "x-agentos-assignment-id",
      );
      let identity = yield* authenticator.authenticate({
        bearerToken,
        assignmentRequirement: requestedAssignmentId === undefined
          ? "not_required"
          : "required",
      });
      if (requestedAssignmentId === undefined && identity.role === "crewmate") {
        identity = yield* authenticator.authenticate({
          bearerToken,
          assignmentRequirement: "required",
        });
      }
      if (
        requestedAssignmentId !== undefined &&
        identity.assignmentId !== requestedAssignmentId
      ) {
        return forbiddenResponse();
      }
      const subject = subjectForIdentity(identity);
      const correlationId = `corr_${yield* id}`;
      const decision = yield* decisionPoint.decide({
        schemaVersion: 1,
        correlationId,
        credentialDomain: route.credentialDomain,
        provider: route.provider,
        capability: route.capability,
        resource: route.resource,
        subject,
      });
      if (
        decision.correlationId !== correlationId ||
        decision.credentialDomain !== route.credentialDomain
      ) {
        return forbiddenResponse();
      }
      if (decision.decision !== "allow" || decision.rateClass === "disabled") {
        return forbiddenResponse();
      }
      const issuedAtMillis = yield* clock;
      const grant = yield* Schema.decodeUnknownEffect(
        ProviderAuthorizationGrantV1Schema,
        { onExcessProperty: "error" },
      )({
        schemaVersion: 1,
        correlationId: decision.correlationId,
        decisionRef: decision.decisionRef,
        expiresAtMillis: Math.min(
          decision.expiresAtMillis,
          issuedAtMillis + PROVIDER_AUTHORIZATION_GRANT_MAX_TTL_MILLIS,
        ),
        credentialDomain: decision.credentialDomain,
        identity: authorizedIdentity(identity),
        capability: route.capability,
        resource: route.resource,
        profile: decision.profile,
        ceiling: decision.ceiling,
        rateClass: decision.rateClass,
      }).pipe(
        Effect.mapError(() => authorizerError("invalid_grant")),
      );
      if (grant.expiresAtMillis <= issuedAtMillis) return forbiddenResponse();
      return new Response(null, {
        status: 200,
        headers: providerAuthorizationGrantHeaders(grant),
      });
    },
  );

  return (request: Request): Effect.Effect<Response> =>
    authorize(request).pipe(
      Effect.catch((error) =>
        Effect.succeed(responseForAuthorizationFailure(error))
      ),
    );
});

const GITHUB_AUTHORIZATION_BODY_MAX_BYTES = 256 * 1_024;
const GitHubOwnerPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GitHubRepositoryPattern = /^[a-z0-9._-]+$/;

function parseRequestPath(path: string): URL | null {
  if (!path.startsWith("/") || path.length > 4_096) return null;
  const base = "http://agentos.invalid";
  return URL.canParse(path, base) ? new URL(path, base) : null;
}

function resolveGitHubAuthorizationRoute(
  method: string,
  url: URL,
  options: {
    readonly body?: string;
    readonly githubRepository?: string;
  },
): Effect.Effect<ProviderAuthorizationRouteV1, ProviderAuthorizationError> {
  const hinted = options.githubRepository === undefined
    ? null
    : parseGitHubRepository(options.githubRepository);
  if (options.githubRepository !== undefined && hinted === null) {
    return Effect.fail(authorizerError("invalid_request"));
  }
  if (url.pathname === "/api/graphql") {
    if (method !== "POST" || options.body === undefined) {
      return Effect.fail(authorizerError("unsupported_route"));
    }
    return resolveGitHubGraphqlRoute(options.body, hinted);
  }

  const rest = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(
    url.pathname,
  );
  if (rest !== null) {
    const resource = githubRepositoryFromSegments(rest[1], rest[2]);
    if (resource === null) {
      return Effect.fail(authorizerError("unsupported_route"));
    }
    if (hinted !== null && !sameGitHubRepository(resource, hinted)) {
      return Effect.fail(authorizerError("resource_mismatch"));
    }
    const tail = rest[3]?.split("/").filter(Boolean) ?? [];
    const capability = githubRestCapability(method, tail);
    return capability === null
      ? Effect.fail(authorizerError("unsupported_route"))
      : Effect.succeed(githubRoute(capability, resource));
  }

  const smart = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname,
  );
  if (smart === null) {
    return Effect.fail(authorizerError("unsupported_route"));
  }
  const resource = githubRepositoryFromSegments(smart[1], smart[2]);
  if (resource === null) {
    return Effect.fail(authorizerError("unsupported_route"));
  }
  if (hinted !== null && !sameGitHubRepository(resource, hinted)) {
    return Effect.fail(authorizerError("resource_mismatch"));
  }
  const operation = smart[3];
  const service = url.searchParams.get("service");
  if (
    (method === "GET" && operation === "info/refs" &&
      service === "git-upload-pack") ||
    (method === "POST" && operation === "git-upload-pack")
  ) {
    return Effect.succeed(githubRoute("github.repository.read", resource));
  }
  if (
    (method === "GET" && operation === "info/refs" &&
      service === "git-receive-pack") ||
    (method === "POST" && operation === "git-receive-pack")
  ) {
    return Effect.succeed(githubRoute("github.contents.write", resource));
  }
  return Effect.fail(authorizerError("unsupported_route"));
}

function githubRestCapability(
  method: string,
  tail: ReadonlyArray<string>,
): Extract<
  ProviderAuthorizationRouteV1,
  { readonly provider: "github" }
>["capability"] | null {
  const section = tail[0]?.toLowerCase();
  if (method === "GET" || method === "HEAD") {
    if (section === "issues") return "github.issue.read";
    if (section === "pulls") return "github.pull_request.read";
    if (section === "actions") return "github.actions.read";
    return "github.repository.read";
  }
  if (
    method === "POST" && section === "actions" &&
    tail[1]?.toLowerCase() === "workflows" &&
    tail.at(-1)?.toLowerCase() === "dispatches"
  ) {
    return "github.actions.dispatch";
  }
  if (
    ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
    section === "issues"
  ) {
    return "github.issue.write";
  }
  if (
    ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
    section === "pulls"
  ) {
    return "github.pull_request.write";
  }
  if (
    ["PUT", "DELETE"].includes(method) && section === "contents"
  ) {
    return "github.contents.write";
  }
  return null;
}

function resolveGitHubGraphqlRoute(
  source: string,
  hinted: GitHubRepositoryResource | null,
): Effect.Effect<ProviderAuthorizationRouteV1, ProviderAuthorizationError> {
  return Effect.gen(function*() {
    if (
      new TextEncoder().encode(source).byteLength >
        GITHUB_AUTHORIZATION_BODY_MAX_BYTES
    ) {
      return yield* authorizerError("invalid_request");
    }
    const body = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(source).pipe(
      Effect.mapError(() => authorizerError("invalid_request")),
    );
    if (!isRecord(body) || typeof body.query !== "string") {
      return yield* authorizerError("invalid_request");
    }
    const variables = isRecord(body.variables) ? body.variables : {};
    const embedded = githubRepositoryFromGraphql(body.query, variables);
    if (
      embedded !== null && hinted !== null &&
      !sameGitHubRepository(embedded, hinted)
    ) {
      return yield* authorizerError("resource_mismatch");
    }
    if (embedded === null) {
      return yield* authorizerError("unsupported_route");
    }
    const query = stripGraphqlComments(body.query);
    if (/\bsubscription\b/.test(query)) {
      return yield* authorizerError("unsupported_route");
    }
    const mutation = /\bmutation\b/.test(query);
    const pullRequestSignal = mutation
      ? hasAnyGraphqlField(query, [
        "addPullRequestReview",
        "addPullRequestReviewThread",
        "addPullRequestReviewThreadReply",
        "closePullRequest",
        "convertPullRequestToDraft",
        "createPullRequest",
        "deletePullRequestReview",
        "deletePullRequestReviewComment",
        "disablePullRequestAutoMerge",
        "dismissPullRequestReview",
        "enablePullRequestAutoMerge",
        "enqueuePullRequest",
        "markFileAsViewed",
        "markPullRequestReadyForReview",
        "mergePullRequest",
        "reopenPullRequest",
        "requestReviews",
        "resolveReviewThread",
        "revertPullRequest",
        "submitPullRequestReview",
        "unmarkFileAsViewed",
      ])
      : /\b(?:pullRequest|pullRequests)\s*\(/.test(query);
    const issueSignal = mutation
      ? hasAnyGraphqlField(query, [
        "addComment",
        "closeIssue",
        "createIssue",
        "deleteIssueComment",
        "reopenIssue",
        "updateIssue",
        "updateIssueComment",
      ])
      : /\b(?:issue|issues)\s*\(/.test(query);
    if (pullRequestSignal && issueSignal) {
      return yield* authorizerError("unsupported_route");
    }
    if (mutation && !pullRequestSignal && !issueSignal) {
      return yield* authorizerError("unsupported_route");
    }
    let capability: Extract<
      ProviderAuthorizationRouteV1,
      { readonly provider: "github" }
    >["capability"] = "github.repository.read";
    if (pullRequestSignal) {
      capability = mutation
        ? "github.pull_request.write"
        : "github.pull_request.read";
    } else if (issueSignal) {
      capability = mutation ? "github.issue.write" : "github.issue.read";
    }
    return githubRoute(capability, embedded);
  });
}

type GitHubRepositoryResource = Extract<
  AuthorizationResourceV1,
  { readonly kind: "github_repository" }
>;

function githubRepositoryFromGraphql(
  query: string,
  variables: Record<string, unknown>,
): GitHubRepositoryResource | null {
  const expressions = [
    /\brepository\s*\(\s*owner\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*,\s*name\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
    /\brepository\s*\(\s*name\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*,\s*owner\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
  ];
  const ownerFirst = expressions[0]!.exec(query);
  if (ownerFirst !== null) {
    return githubRepositoryFromUnknown(
      variables[ownerFirst[1]!],
      variables[ownerFirst[2]!],
    );
  }
  const nameFirst = expressions[1]!.exec(query);
  if (nameFirst !== null) {
    return githubRepositoryFromUnknown(
      variables[nameFirst[2]!],
      variables[nameFirst[1]!],
    );
  }
  return null;
}

function githubRepositoryFromSegments(
  owner: string | undefined,
  repository: string | undefined,
): GitHubRepositoryResource | null {
  if (owner === undefined || repository === undefined) return null;
  const decodedOwner = Schema.decodeUnknownOption(
    Schema.StringFromUriComponent,
  )(owner);
  const decodedRepository = Schema.decodeUnknownOption(
    Schema.StringFromUriComponent,
  )(repository);
  return Option.isSome(decodedOwner) && Option.isSome(decodedRepository)
    ? githubRepositoryFromUnknown(decodedOwner.value, decodedRepository.value)
    : null;
}

function githubRepositoryFromUnknown(
  owner: unknown,
  repository: unknown,
): GitHubRepositoryResource | null {
  if (typeof owner !== "string" || typeof repository !== "string") return null;
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepository = repository.toLowerCase();
  if (
    normalizedOwner.length > 39 || normalizedRepository.length > 100 ||
    !GitHubOwnerPattern.test(normalizedOwner) ||
    !GitHubRepositoryPattern.test(normalizedRepository)
  ) {
    return null;
  }
  return {
    kind: "github_repository",
    owner: normalizedOwner,
    repository: normalizedRepository,
  };
}

function parseGitHubRepository(value: string): GitHubRepositoryResource | null {
  const segments = value.split("/");
  return segments.length === 2
    ? githubRepositoryFromUnknown(segments[0], segments[1])
    : null;
}

function githubRoute(
  capability: Extract<
    ProviderAuthorizationRouteV1,
    { readonly provider: "github" }
  >["capability"],
  resource: GitHubRepositoryResource,
): Extract<ProviderAuthorizationRouteV1, { readonly provider: "github" }> {
  return {
    credentialDomain: "github",
    provider: "github",
    capability,
    resource,
  };
}

function sameGitHubRepository(
  left: GitHubRepositoryResource,
  right: GitHubRepositoryResource,
): boolean {
  return left.owner === right.owner && left.repository === right.repository;
}

function hasAnyGraphqlField(
  query: string,
  fields: ReadonlyArray<string>,
): boolean {
  return fields.some((field) =>
    new RegExp(`\\b${field}\\s*\\(`).test(query)
  );
}

function stripGraphqlComments(query: string): string {
  return query.replace(/#[^\n\r]*/g, "");
}

function authorizationResourceFromHeaders(headers: Headers): unknown {
  const kind = requiredHeader(headers, "x-agentos-authz-resource-kind");
  switch (kind) {
    case "provider_service":
      return {
        kind,
        provider: requiredHeader(headers, "x-agentos-authz-provider"),
        service: requiredHeader(headers, "x-agentos-authz-service"),
      };
    case "github_repository":
      return {
        kind,
        owner: requiredHeader(headers, "x-agentos-authz-resource-owner"),
        repository: requiredHeader(
          headers,
          "x-agentos-authz-resource-repository",
        ),
      };
    case "github_project":
      return {
        kind,
        organization: requiredHeader(
          headers,
          "x-agentos-authz-resource-organization",
        ),
        projectNumber: integerHeader(
          headers,
          "x-agentos-authz-resource-project-number",
        ),
      };
    default:
      return { kind };
  }
}

function authorizationResourceKey(resource: AuthorizationResourceV1): string {
  switch (resource.kind) {
    case "provider_service":
      return `provider_service:${resource.provider}:${resource.service}`;
    case "provider_account":
      return `provider_account:${resource.provider}:${resource.account}`;
    case "provider_adapter":
      return `provider_adapter:${resource.provider}:${resource.adapter}`;
    case "github_repository":
      return `github_repository:${resource.owner}/${resource.repository}`;
    case "github_project":
      return `github_project:${resource.organization}/${resource.projectNumber}`;
  }
}

const readBoundedAuthorizationBody = Effect.fn(
  "agentos.providerAuthorization.readBody",
)(function*(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > GITHUB_AUTHORIZATION_BODY_MAX_BYTES)
  ) {
    return yield* authorizerError("invalid_request");
  }
  const body = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => authorizerError("invalid_request"),
  });
  if (new TextEncoder().encode(body).byteLength > GITHUB_AUTHORIZATION_BODY_MAX_BYTES) {
    return yield* authorizerError("invalid_request");
  }
  return body.length === 0 ? undefined : body;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorizedIdentity(
  identity: WorkloadIdentityV1,
): ProviderAuthorizedIdentityV1 {
  return {
    agentId: identity.agentId,
    role: identity.role,
    fleet: identity.fleet,
    domain: identity.domain,
    assignmentId: identity.assignmentId,
  };
}

function subjectForIdentity(
  identity: WorkloadIdentityV1,
): AuthorizationSubjectV1 {
  if (identity.assignmentId !== null) {
    return {
      kind: "assignment",
      fleet: identity.fleet,
      domain: identity.domain,
      assignmentId: identity.assignmentId,
    };
  }
  return {
    kind: "mate",
    fleet: identity.fleet,
    domain: identity.domain,
    agentId: identity.agentId,
  };
}

function providerForAuthorizationResource(
  resource: AuthorizationResourceV1,
): "github" | "openai" | "" {
  switch (resource.kind) {
    case "provider_service":
    case "provider_account":
    case "provider_adapter":
      return resource.provider;
    case "github_repository":
    case "github_project":
      return "github";
  }
}

function serviceForAuthorizationResource(
  resource: AuthorizationResourceV1,
): string {
  return resource.kind === "provider_service" ? resource.service : "";
}

function bearerTokenFrom(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (!authorization) return null;
  const bearer = /^(?:Bearer|token)\s+(\S+)$/i.exec(authorization)?.[1];
  const basic = /^Basic\s+(\S+)$/i.exec(authorization)?.[1];
  let token = bearer;
  if (token === undefined && basic !== undefined) {
    const decoded = Result.getOrUndefined(Encoding.decodeBase64String(basic));
    if (decoded === undefined) return null;
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    const username = decoded.slice(0, separator);
    if (username !== "x-access-token" && username !== "agentos") return null;
    token = decoded.slice(separator + 1);
  }
  if (!token || /\s/.test(token)) return null;
  return token.length <= 16 * 1_024 ? token : null;
}

function requiredHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value && value.length <= 512 ? value : null;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  return requiredHeader(headers, name) ?? undefined;
}

function integerHeader(headers: Headers, name: string): number {
  const source = requiredHeader(headers, name);
  if (source === null || !/^(?:0|[1-9][0-9]*)$/.test(source)) return NaN;
  return Number(source);
}

function authorizerError(code: ProviderAuthorizationError["code"]) {
  return ProviderAuthorizationError.make({ code });
}

function responseForAuthorizationFailure(error: unknown): Response {
  if (error instanceof ProviderPolicyDecisionError) {
    switch (error.outcome) {
      case "database_unavailable":
      case "policy_stale":
      case "openfga_unavailable":
      case "decision_reference_unavailable":
        return unavailableResponse();
      case "invalid_route":
      case "identity_rejected":
      case "profile_denied":
      case "ceiling_denied":
      case "effective_policy_denied":
      case "rate_class_disabled":
      case "rate_class_exceeded":
      case "rate_limited":
      case "budget_exhausted":
        return forbiddenResponse();
    }
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    error._tag === "WorkloadIdentityDependencyUnavailable"
  ) {
    return unavailableResponse();
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    (error._tag === "WorkloadAuthenticationError" ||
      error._tag === "WorkloadIdentityResolutionError")
  ) {
    return unauthorizedResponse();
  }
  return forbiddenResponse();
}

function unavailableResponse(): Response {
  return Response.json({ error: "authorization_unavailable" }, {
    status: 503,
  });
}

function unauthorizedResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function forbiddenResponse(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}
