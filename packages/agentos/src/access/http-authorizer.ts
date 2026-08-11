import { Clock, Context, Effect, Encoding, Option, Result, Schema } from "effect";

import {
  AccessCapabilityIdSchema,
  AccessCeilingRefV1Schema,
  AccessProfileRefV1Schema,
  AccessRateClassIdSchema,
  AuthorizationResourceV1Schema,
  type AccessCapabilityId,
  type AuthorizationResourceV1,
  type AuthorizationSubjectV1,
  KubernetesWorkloadPrincipalV1Schema,
} from "./contracts.ts";
import {
  ProviderPolicyDecisionError,
} from "./credential-delivery.ts";
import {
  WorkloadIdentityV1Schema,
} from "./identity.ts";
import type { HermesProviderAuthorization } from "./hermes-authorizer.ts";
import {
  ProviderBudgetEnforcementError,
  type ProviderBudgetEnforcer,
} from "./provider-budget.ts";
import {
  HermesProviderAccessGrantV1Schema,
  HermesProviderLimitsV1Schema,
  HermesProviderModelIdSchema,
  normalizeHermesProviderModelId,
} from "./kubernetes-workload-policy.ts";
import type {
  ProviderAccessTelemetry,
  ProviderAccessTelemetryEnd,
  ProviderAccessTelemetryOperation,
  ProviderAccessTelemetryStart,
} from "../telemetry/provider-access.ts";

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

const ProviderAuthorizationGrantCommonV1Fields = {
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  decisionRef: DecisionRef,
  expiresAtMillis: EpochMillis,
  credentialDomain: Schema.Literals(["github", "openai-responses"]),
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  rateClass: AccessRateClassIdSchema,
};

const AgentOSProviderAuthorizationGrantV1Schema = Schema.Struct({
  ...ProviderAuthorizationGrantCommonV1Fields,
  identity: ProviderAuthorizedIdentityV1Schema,
  profile: AccessProfileRefV1Schema,
  ceiling: AccessCeilingRefV1Schema,
});

export const HermesProviderAuthorizationGrantV1Schema = Schema.Struct({
  ...ProviderAuthorizationGrantCommonV1Fields,
  identity: KubernetesWorkloadPrincipalV1Schema,
  model: HermesProviderModelIdSchema,
  limits: HermesProviderLimitsV1Schema,
  pricing: HermesProviderAccessGrantV1Schema.fields.pricing,
  requestedTokens: EpochMillis,
  requestedSpendMicros: EpochMillis,
});

export const ProviderAuthorizationGrantV1Schema = Schema.Union([
  AgentOSProviderAuthorizationGrantV1Schema,
  HermesProviderAuthorizationGrantV1Schema,
]);

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

const reservationSubjectMatchesGrant = Schema.makeFilter((input: {
  readonly grant: typeof HermesProviderAuthorizationGrantV1Schema.Type;
  readonly subject: typeof KubernetesWorkloadPrincipalV1Schema.Type;
}) => sameKubernetesWorkloadPrincipal(input.grant.identity, input.subject), {
  title: "reservation subject must match the workload grant",
});

export const ProviderBudgetReservationRequestV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  grant: HermesProviderAuthorizationGrantV1Schema,
  subject: KubernetesWorkloadPrincipalV1Schema,
}).pipe(Schema.check(reservationSubjectMatchesGrant));

export const ProviderBudgetReservationAcceptanceV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  outcome: Schema.Literal("reserved"),
  grant: HermesProviderAuthorizationGrantV1Schema,
  subject: KubernetesWorkloadPrincipalV1Schema,
}).pipe(Schema.check(reservationSubjectMatchesGrant));

export type ProviderBudgetReservationRequestV1 =
  typeof ProviderBudgetReservationRequestV1Schema.Type;
export type ProviderBudgetReservationAcceptanceV1 =
  typeof ProviderBudgetReservationAcceptanceV1Schema.Type;

const ProviderBudgetReservationRequestErrorCode = Schema.Literals([
  "unavailable",
  "rejected",
  "invalid_response",
]);

export class ProviderBudgetReservationRequestError extends Schema.TaggedErrorClass<ProviderBudgetReservationRequestError>()(
  "ProviderBudgetReservationRequestError",
  { code: ProviderBudgetReservationRequestErrorCode },
) {}

export class ProviderBudgetReservationRequester extends Context.Service<
  ProviderBudgetReservationRequester,
  {
    readonly request: (
      request: ProviderBudgetReservationRequestV1,
    ) => Effect.Effect<unknown, ProviderBudgetReservationRequestError>;
  }
>()("agentos/access/ProviderBudgetReservationRequester") {}

export const denyProviderBudgetReservationRequester =
  ProviderBudgetReservationRequester.of({
    request: () => Effect.fail(ProviderBudgetReservationRequestError.make({
      code: "unavailable",
    })),
  });

function sameKubernetesWorkloadPrincipal(
  left: typeof KubernetesWorkloadPrincipalV1Schema.Type,
  right: typeof KubernetesWorkloadPrincipalV1Schema.Type,
): boolean {
  return left.kind === right.kind &&
    left.namespace === right.namespace &&
    left.serviceAccountName === right.serviceAccountName &&
    left.policyRevision === right.policyRevision &&
    left.policyResourceVersion === right.policyResourceVersion &&
    left.hermesProfile === right.hermesProfile;
}

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
  "x-agentos-authz-principal-kind",
  "x-agentos-authz-workload-namespace",
  "x-agentos-authz-service-account",
  "x-agentos-authz-policy-revision",
  "x-agentos-authz-policy-resource-version",
  "x-agentos-authz-hermes-profile",
  "x-agentos-authz-model",
  "x-agentos-authz-request-window-millis",
  "x-agentos-authz-maximum-requests",
  "x-agentos-authz-maximum-concurrent",
  "x-agentos-authz-token-window-millis",
  "x-agentos-authz-maximum-tokens",
  "x-agentos-authz-spend-window-millis",
  "x-agentos-authz-maximum-spend-micros",
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
    "x-agentos-authz-capability": grant.capability,
    "x-agentos-authz-resource-kind": grant.resource.kind,
    "x-agentos-authz-provider":
      providerForAuthorizationResource(grant.resource),
    "x-agentos-authz-service": serviceForAuthorizationResource(grant.resource),
    "x-agentos-authz-rate-class": grant.rateClass,
  });
  const workload = "model" in grant;
  if (workload) {
    headers.set("x-agentos-authz-principal-kind", "kubernetes_workload");
    headers.set("x-agentos-authz-workload-namespace", grant.identity.namespace);
    headers.set("x-agentos-authz-service-account", grant.identity.serviceAccountName);
    headers.set("x-agentos-authz-policy-revision", String(grant.identity.policyRevision));
    headers.set("x-agentos-authz-policy-resource-version", grant.identity.policyResourceVersion);
    headers.set("x-agentos-authz-hermes-profile", grant.identity.hermesProfile);
    headers.set("x-agentos-authz-model", grant.model);
    headers.set("x-agentos-authz-request-window-millis", String(grant.limits.requestWindowMillis));
    headers.set("x-agentos-authz-maximum-requests", String(grant.limits.maximumRequests));
    headers.set("x-agentos-authz-maximum-concurrent", String(grant.limits.maximumConcurrent));
    headers.set("x-agentos-authz-token-window-millis", String(grant.limits.tokenWindowMillis));
    headers.set("x-agentos-authz-maximum-tokens", String(grant.limits.maximumTokens));
    headers.set("x-agentos-authz-spend-window-millis", String(grant.limits.spendWindowMillis));
    headers.set("x-agentos-authz-maximum-spend-micros", String(grant.limits.maximumSpendMicros));
    headers.set("x-agentos-authz-pricing-version", String(grant.pricing.version));
    headers.set("x-agentos-authz-input-micros-per-million-tokens", String(grant.pricing.inputMicrosPerMillionTokens));
    headers.set("x-agentos-authz-output-micros-per-million-tokens", String(grant.pricing.outputMicrosPerMillionTokens));
    headers.set("x-agentos-authz-requested-tokens", String(grant.requestedTokens));
    headers.set("x-agentos-authz-requested-spend-micros", String(grant.requestedSpendMicros));
  } else {
    headers.set("x-agentos-authz-principal-kind", "agentos");
    headers.set("x-agentos-authz-agent-id", grant.identity.agentId);
    headers.set("x-agentos-authz-role", grant.identity.role);
    headers.set("x-agentos-authz-fleet", grant.identity.fleet);
    headers.set("x-agentos-authz-domain", grant.identity.domain);
    headers.set("x-agentos-authz-profile-id", grant.profile.profileId);
    headers.set("x-agentos-authz-profile-version", String(grant.profile.profileVersion));
    headers.set("x-agentos-authz-ceiling-id", grant.ceiling.ceilingId);
    headers.set("x-agentos-authz-ceiling-revision", String(grant.ceiling.revision));
  }
  // Emit the optional field even when it is absent so ext-auth overwrites a
  // caller-supplied grant header instead of accidentally preserving it.
  headers.set(
    "x-agentos-authz-assignment-id",
    workload ? "" : grant.identity.assignmentId ?? "",
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
    identity: authorizationIdentityFromHeaders(headers),
    capability: requiredHeader(headers, "x-agentos-authz-capability"),
    resource: authorizationResourceFromHeaders(headers),
    rateClass: requiredHeader(headers, "x-agentos-authz-rate-class"),
    ...authorizationPolicyFieldsFromHeaders(headers),
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
  if ("model" in grant) {
    const model = modelFromAuthorizationBody(request.body);
    if (model === null || normalizeHermesProviderModelId(model) !== grant.model) {
      return yield* authorizerError("grant_route_mismatch");
    }
  }
  return grant;
});

export const createProviderAuthorizationHttpHandler = Effect.fn(
  "agentos.providerAuthorization.createHttpHandler",
)(function*(options: {
  readonly clock?: Effect.Effect<number>;
  readonly id: Effect.Effect<string, ProviderPolicyDecisionError>;
  readonly telemetry?: ProviderAccessTelemetry["Service"];
  readonly hermes: HermesProviderAuthorization;
  readonly budgets?: ProviderBudgetEnforcer["Service"];
}) {
  const clock = options.clock ?? Clock.currentTimeMillis;
  const id = options.id;

  const authorize = Effect.fn("agentos.providerAuthorization.authorizeHttp")(
    function*(
      request: Request,
      telemetry?: ProviderAccessTelemetryOperation,
    ) {
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
      const issuedAtMillis = yield* clock;
      const hermes = yield* options.hermes.authorize({
        bearerToken,
        route,
        body,
        atMillis: issuedAtMillis,
      });
      const correlationId = `corr_${yield* id}`;
      const grant = yield* Schema.decodeUnknownEffect(
        ProviderAuthorizationGrantV1Schema,
        { onExcessProperty: "error" },
      )({
        schemaVersion: 1,
        correlationId,
        decisionRef: `decision_${correlationId.slice(5)}`,
        expiresAtMillis: Math.min(
          hermes.tokenExpiresAtMillis,
          hermes.policyExpiresAtMillis ?? Number.MAX_SAFE_INTEGER,
          issuedAtMillis + PROVIDER_AUTHORIZATION_GRANT_MAX_TTL_MILLIS,
        ),
        credentialDomain: hermes.grant.credentialDomain,
        identity: hermes.grant.principal,
        capability: route.capability,
        resource: route.resource,
        rateClass: hermes.grant.rateClass,
        model: hermes.grant.model,
        limits: hermes.grant.limits,
        pricing: hermes.grant.pricing,
        requestedTokens: hermes.requestedTokens,
        requestedSpendMicros: hermes.requestedSpendMicros,
      }).pipe(Effect.mapError(() => authorizerError("invalid_grant")));
      if (grant.expiresAtMillis <= issuedAtMillis) return forbiddenResponse();
      if (
        options.budgets?.reserveWorkload === undefined ||
        hermes.workloadIdentity === undefined
      ) {
        return unavailableResponse();
      }
      yield* options.budgets.reserveWorkload({
        schemaVersion: 1,
        decisionRef: grant.decisionRef,
        correlationId: grant.correlationId,
        principal: { ...hermes.grant.principal, ...hermes.workloadIdentity },
        provider: "openai",
        credentialDomain: "openai-responses",
        capability: grant.capability === "openai.responses.create"
          ? "openai.responses.create"
          : "openai.responses.compact",
        resource: grant.resource,
        environment: "production",
        model: hermes.grant.model,
        rateClass: grant.rateClass,
        limits: hermes.grant.limits,
        pricing: hermes.grant.pricing,
        policyExpiresAtMillis: grant.expiresAtMillis,
        requestedTokens: hermes.requestedTokens,
        requestedSpendMicros: hermes.requestedSpendMicros,
        nowMillis: issuedAtMillis,
      });
      if (telemetry !== undefined) yield* telemetry.correlate(grant);
      return new Response(null, {
        status: 200,
        headers: providerAuthorizationGrantHeaders(grant),
      });
    },
  );

  return (request: Request): Effect.Effect<Response> =>
    Effect.gen(function*() {
      const telemetry = options.telemetry === undefined
        ? undefined
        : yield* options.telemetry.start(
            providerAccessTelemetryStart(request),
          );
      const result = yield* Effect.result(authorize(request, telemetry));
      if (result._tag === "Failure") {
        const response = responseForAuthorizationFailure(result.failure);
        if (telemetry !== undefined) {
          yield* telemetry.end(
            providerAccessFailure(result.failure, response.status),
          );
        }
        return response;
      }
      if (telemetry !== undefined) {
        yield* telemetry.end(providerAccessResponse(result.success));
      }
      return result.success;
    });
});

function providerAccessTelemetryStart(
  request: Request,
): ProviderAccessTelemetryStart {
  const route = providerAccessRoute(
    request.headers.get("x-agentos-original-path"),
  );
  return {
    request,
    operation: "authorization",
    route,
    adapter: "egress_authz",
    provider: route === "openai_responses" || route === "openai_compaction"
      ? "openai"
      : route === "github_rest" || route === "github_graphql" ||
          route === "github_git"
      ? "github"
      : "unknown",
  };
}

function providerAccessRoute(
  path: string | null,
): ProviderAccessTelemetryStart["route"] {
  if (path === "/v1/responses") return "openai_responses";
  if (path === "/v1/responses/compact") return "openai_compaction";
  if (path === "/api/graphql") return "github_graphql";
  if (path?.startsWith("/api/v3/") === true) return "github_rest";
  if (
    path !== null &&
    /^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)(?:\?.*)?$/.test(
      path,
    )
  ) {
    return "github_git";
  }
  return "unknown";
}

function providerAccessResponse(response: Response): ProviderAccessTelemetryEnd {
  if (response.status === 200) {
    return {
      decision: "allow",
      reason: "allowed",
      dependency: "none",
      providerOutcome: "unobserved",
      status: response.status,
    };
  }
  if (response.status === 401) {
    return {
      decision: "deny",
      reason: "identity_invalid",
      dependency: "none",
      providerOutcome: "not_forwarded",
      status: response.status,
    };
  }
  if (response.status === 429) {
    const budget = response.headers.get("x-agentos-denial-reason") ===
      "budget_exhausted";
    return {
      decision: "deny",
      reason: budget ? "budget_denied" : "rate_limited",
      dependency: budget ? "postgresql" : "none",
      providerOutcome: "not_forwarded",
      status: response.status,
    };
  }
  return {
    decision: response.status >= 500 ? "error" : "deny",
    reason: response.status >= 500 ? "dependency_unavailable" : "unknown",
    dependency: response.status >= 500 ? "authorizer" : "none",
    providerOutcome: "not_forwarded",
    status: response.status,
  };
}

function providerAccessFailure(
  error: unknown,
  status: number,
): ProviderAccessTelemetryEnd {
  if (error instanceof ProviderPolicyDecisionError) {
    switch (error.outcome) {
      case "database_unavailable":
        return accessFailure("dependency_unavailable", "postgresql", status);
      case "policy_stale":
        return accessFailure("policy_stale", "postgresql", status);
      case "openfga_unavailable":
        return accessFailure("dependency_unavailable", "openfga", status);
      case "decision_reference_unavailable":
        return accessFailure("dependency_unavailable", "authorizer", status);
      case "identity_rejected":
        return accessDenial("identity_invalid", "postgresql", status);
      case "profile_denied":
      case "effective_policy_denied":
        return accessDenial("profile_denied", "none", status);
      case "ceiling_denied":
        return accessDenial("ceiling_denied", "none", status);
      case "rate_class_disabled":
      case "rate_class_exceeded":
      case "rate_limited":
        return accessDenial("rate_limited", "postgresql", status);
      case "budget_exhausted":
        return accessDenial("budget_denied", "postgresql", status);
      case "invalid_route":
        return accessDenial("unknown", "none", status);
    }
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    (error._tag === "WorkloadIdentityDependencyUnavailable" ||
      error._tag === "HermesProviderAccessPolicyDependencyUnavailable")
  ) {
    const dependency = "dependency" in error &&
        error.dependency === "identity_store"
      ? "postgresql"
      : "kubernetes";
    return accessFailure("dependency_unavailable", dependency, status);
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    error._tag === "WorkloadIdentityResolutionError"
  ) {
    const assignment = "code" in error && typeof error.code === "string" &&
      error.code.startsWith("assignment_");
    return accessDenial(
      assignment ? "assignment_inactive" : "identity_invalid",
      "postgresql",
      status,
    );
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    error._tag === "WorkloadAuthenticationError"
  ) {
    return accessDenial("identity_invalid", "kubernetes", status);
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    (error._tag === "WorkloadAuthorizationError" ||
      error._tag === "WorkloadPolicyDenied")
  ) {
    return accessDenial("identity_invalid", "postgresql", status);
  }
  return providerAccessResponse(new Response(null, { status }));
}

function accessFailure(
  reason: ProviderAccessTelemetryEnd["reason"],
  dependency: ProviderAccessTelemetryEnd["dependency"],
  status: number,
): ProviderAccessTelemetryEnd {
  return {
    decision: "error",
    reason,
    dependency,
    providerOutcome: "not_forwarded",
    status,
  };
}

function accessDenial(
  reason: ProviderAccessTelemetryEnd["reason"],
  dependency: ProviderAccessTelemetryEnd["dependency"],
  status: number,
): ProviderAccessTelemetryEnd {
  return {
    decision: "deny",
    reason,
    dependency,
    providerOutcome: "not_forwarded",
    status,
  };
}

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
    case "agent_skill":
      return `agent_skill:${resource.targetAgentId}/${resource.skillId}`;
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


function providerForAuthorizationResource(
  resource: AuthorizationResourceV1,
): "agentos" | "github" | "openai" | "" {
  switch (resource.kind) {
    case "agent_skill":
      return "agentos";
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

function authorizationIdentityFromHeaders(headers: Headers) {
  if (requiredHeader(headers, "x-agentos-authz-principal-kind") === "kubernetes_workload") {
    return {
      kind: "kubernetes_workload",
      namespace: requiredHeader(headers, "x-agentos-authz-workload-namespace"),
      serviceAccountName: requiredHeader(headers, "x-agentos-authz-service-account"),
      policyRevision: integerHeader(headers, "x-agentos-authz-policy-revision"),
      policyResourceVersion: requiredHeader(
        headers,
        "x-agentos-authz-policy-resource-version",
      ),
      hermesProfile: requiredHeader(headers, "x-agentos-authz-hermes-profile"),
    };
  }
  return {
    agentId: requiredHeader(headers, "x-agentos-authz-agent-id"),
    role: requiredHeader(headers, "x-agentos-authz-role"),
    fleet: requiredHeader(headers, "x-agentos-authz-fleet"),
    domain: requiredHeader(headers, "x-agentos-authz-domain"),
    assignmentId: optionalHeader(
      headers,
      "x-agentos-authz-assignment-id",
    ) ?? null,
  };
}

function authorizationPolicyFieldsFromHeaders(headers: Headers) {
  if (requiredHeader(headers, "x-agentos-authz-principal-kind") === "kubernetes_workload") {
    return {
      model: requiredHeader(headers, "x-agentos-authz-model"),
      limits: {
        requestWindowMillis: integerHeader(
          headers,
          "x-agentos-authz-request-window-millis",
        ),
        maximumRequests: integerHeader(headers, "x-agentos-authz-maximum-requests"),
        maximumConcurrent: integerHeader(
          headers,
          "x-agentos-authz-maximum-concurrent",
        ),
        tokenWindowMillis: integerHeader(
          headers,
          "x-agentos-authz-token-window-millis",
        ),
        maximumTokens: integerHeader(headers, "x-agentos-authz-maximum-tokens"),
        spendWindowMillis: integerHeader(
          headers,
          "x-agentos-authz-spend-window-millis",
        ),
        maximumSpendMicros: integerHeader(
          headers,
          "x-agentos-authz-maximum-spend-micros",
        ),
      },
      pricing: {
        version: integerHeader(headers, "x-agentos-authz-pricing-version"),
        inputMicrosPerMillionTokens: integerHeader(
          headers,
          "x-agentos-authz-input-micros-per-million-tokens",
        ),
        outputMicrosPerMillionTokens: integerHeader(
          headers,
          "x-agentos-authz-output-micros-per-million-tokens",
        ),
      },
      requestedTokens: integerHeader(headers, "x-agentos-authz-requested-tokens"),
      requestedSpendMicros: integerHeader(
        headers,
        "x-agentos-authz-requested-spend-micros",
      ),
    };
  }
  return {
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
  };
}

function modelFromAuthorizationBody(body: string | undefined): string | null {
  if (body === undefined) return null;
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
    { onExcessProperty: "ignore" },
  )(body);
  return Option.isSome(decoded) ? decoded.value.model : null;
}

function authorizerError(code: ProviderAuthorizationError["code"]) {
  return ProviderAuthorizationError.make({ code });
}

function responseForAuthorizationFailure(error: unknown): Response {
  if (error instanceof ProviderBudgetEnforcementError) {
    if (error.outcome === "rate_limited" || error.outcome === "budget_exhausted") {
      return quotaDeniedResponse(error.outcome);
    }
    return error.outcome === "rate_class_disabled"
      ? forbiddenResponse()
      : unavailableResponse();
  }
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
        return forbiddenResponse();
      case "rate_limited":
      case "budget_exhausted":
        return quotaDeniedResponse(error.outcome);
    }
  }
  if (
    typeof error === "object" && error !== null && "_tag" in error &&
    (error._tag === "WorkloadIdentityDependencyUnavailable" ||
      error._tag === "HermesProviderAccessPolicyDependencyUnavailable")
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

function quotaDeniedResponse(
  outcome: "rate_limited" | "budget_exhausted",
): Response {
  return Response.json({ error: outcome }, {
    status: 429,
    headers: { "x-agentos-denial-reason": outcome },
  });
}
