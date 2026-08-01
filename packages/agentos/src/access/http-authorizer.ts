import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";

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
  credentialDomain: Schema.Literal("openai-responses"),
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

export interface ProviderAuthorizationRouteV1 {
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
  "x-agentos-authz-profile-id",
  "x-agentos-authz-profile-version",
  "x-agentos-authz-ceiling-id",
  "x-agentos-authz-ceiling-revision",
  "x-agentos-authz-rate-class",
] as const);

export function resolveProviderAuthorizationRoute(
  method: string,
  path: string,
): Effect.Effect<ProviderAuthorizationRouteV1, ProviderAuthorizationError> {
  if (method !== "POST") {
    return Effect.fail(authorizerError("unsupported_route"));
  }
  const compact = path === "/responses/compact" ||
    path === "/v1/responses/compact";
  const create = path === "/responses" || path === "/v1/responses" ||
    path === "/codex/responses";
  if (!compact && !create) {
    return Effect.fail(authorizerError("unsupported_route"));
  }
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
  },
) {
  const route = yield* resolveProviderAuthorizationRoute(
    request.method,
    request.path,
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
    resource: {
      kind: requiredHeader(headers, "x-agentos-authz-resource-kind"),
      provider: requiredHeader(headers, "x-agentos-authz-provider"),
      service: requiredHeader(headers, "x-agentos-authz-service"),
    },
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
    serviceForAuthorizationResource(grant.resource) !== route.resource.service
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
  readonly clock?: () => number;
  readonly id?: () => string;
}) {
  const authenticator = yield* WorkloadIdentityAuthenticator;
  const decisionPoint = yield* ProviderPolicyDecisionPoint;
  const clock = options.clock ?? Date.now;
  const id = options.id ?? (() => randomUUID().replaceAll("-", ""));

  const authorize = Effect.fn("agentos.providerAuthorization.authorizeHttp")(
    function*(request: Request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/authorize") {
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
      const routeResult = yield* Effect.result(
        resolveProviderAuthorizationRoute(method, path),
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
      const correlationId = `corr_${id()}`;
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
      const issuedAtMillis = clock();
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

  return (request: Request): Promise<Response> =>
    Effect.runPromise(
      authorize(request).pipe(
        Effect.catch((error) =>
          Effect.succeed(responseForAuthorizationFailure(error))
        ),
      ),
    );
});

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
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
  const token = authorization.replace(/^Bearer\s+/i, "");
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
  if (
    typeof error === "object" && error !== null && "outcome" in error &&
    typeof error.outcome === "string" &&
    [
      "credential_unavailable",
      "credential_rejected",
      "credential_rotating",
      "credential_exchange_failed",
    ].includes(error.outcome)
  ) {
    return Response.json({ error: "authorization_unavailable" }, {
      status: 503,
    });
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    error._tag === "WorkloadIdentityDependencyUnavailable"
  ) {
    return Response.json({ error: "authorization_unavailable" }, {
      status: 503,
    });
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

function unauthorizedResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function forbiddenResponse(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}
