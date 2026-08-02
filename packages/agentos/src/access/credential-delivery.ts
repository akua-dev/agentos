import { Context, Effect, Schema } from "effect";

import {
  AccessCeilingRefV1Schema,
  AccessCapabilityIdSchema,
  AccessProfileRefV1Schema,
  AccessProviderIdSchema,
  AccessRateClassIdSchema,
  AuthorizationResourceV1Schema,
  AuthorizationSubjectV1Schema,
} from "./contracts.ts";
import { WorkloadIdentityV1Schema } from "./identity.ts";

const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const CredentialDomain = KubernetesName;
const SecretKey = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(253),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
  ),
);
const ResourceVersion = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z](?:[0-9A-Za-z_.:-]*[0-9A-Za-z])?$/),
  ),
);
const DnsHost = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(253),
    Schema.isPattern(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    ),
  ),
);
const HttpsUrl = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(2048),
    Schema.isPattern(
      /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*)?$/,
    ),
  ),
);
const HeaderName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
);
const HeaderPrefix = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(32), Schema.isPattern(/^[\x20-\x7e]*$/)),
);
const CorrelationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^corr_[0-9a-f]{32}$/)),
);
const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export const AGENTOS_PROVIDER_CREDENTIAL_NAMESPACE = "agentos";
export const AGENTOS_PROVIDER_CREDENTIAL_MOUNT_ROOT =
  "/var/run/secrets/agentos-provider";
export const AGENTOS_PROVIDER_CREDENTIAL_MAX_STALE_MILLIS = 60_000;

export const ProviderSecretRefV1Schema = Schema.Struct({
  namespace: KubernetesName,
  name: KubernetesName,
  key: SecretKey,
  resourceVersion: ResourceVersion,
});

const StaticHeaderMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("static_header"),
  headerName: HeaderName,
  prefix: HeaderPrefix,
  secretRef: ProviderSecretRefV1Schema,
});

const OAuthTokenExchangeMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("oauth_token_exchange"),
  upstreamSupportsTokenExchange: Schema.Boolean,
  clientId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  clientAuthentication: Schema.Literals([
    "client_secret_basic",
    "client_secret_post",
  ]),
  tokenEndpoint: HttpsUrl,
  subjectTokenAudience: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  secretRef: ProviderSecretRefV1Schema,
});

const AwsWorkloadIdentityMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("aws_workload_identity"),
  roleArn: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(2048),
      Schema.isPattern(/^arn:aws(?:-[a-z]+)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/),
    ),
  ),
});

const GcpWorkloadIdentityMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("gcp_workload_identity"),
  audience: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(2048),
      Schema.isPattern(/^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/),
    ),
  ),
});

const GitHubAppMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("github_app"),
  brokerService: KubernetesName,
  secretRef: ProviderSecretRefV1Schema,
});

const RefreshTokenMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("refresh_token"),
  brokerService: KubernetesName,
  secretRef: ProviderSecretRefV1Schema,
});

const UnsupportedNativeClientMechanismV1Schema = Schema.Struct({
  kind: Schema.Literal("unsupported_native_client"),
  client: KubernetesName,
});

export const ProviderCredentialMechanismV1Schema = Schema.Union([
  StaticHeaderMechanismV1Schema,
  OAuthTokenExchangeMechanismV1Schema,
  AwsWorkloadIdentityMechanismV1Schema,
  GcpWorkloadIdentityMechanismV1Schema,
  GitHubAppMechanismV1Schema,
  RefreshTokenMechanismV1Schema,
  UnsupportedNativeClientMechanismV1Schema,
]);

export const ProviderCredentialPlanInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  credentialDomain: CredentialDomain,
  provider: AccessProviderIdSchema,
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  upstreamHosts: Schema.NonEmptyArray(DnsHost),
  mechanism: ProviderCredentialMechanismV1Schema,
});

const SecretProjectionV1Schema = Schema.Struct({
  secretRef: ProviderSecretRefV1Schema,
  mountPath: Schema.String,
  mode: Schema.Literal(0o440),
  readOnly: Schema.Literal(true),
});

const DeliveryBaseFields = {
  adapter: KubernetesName,
  forwardOnly: Schema.Literal(true),
  returnsCredentialToCaller: Schema.Literal(false),
  readiness: Schema.Literal("credential_reference_loaded"),
  zeroization: Schema.Literal("drop_request_scoped_material_after_forward"),
};

export const ProviderCredentialDeliveryV1Schema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agentgateway_static_header"),
    ...DeliveryBaseFields,
    headerName: HeaderName,
    prefix: HeaderPrefix,
    valueFile: Schema.String,
    secretProjection: SecretProjectionV1Schema,
  }),
  Schema.Struct({
    kind: Schema.Literal("agentgateway_oauth_token_exchange"),
    ...DeliveryBaseFields,
    clientId: Schema.String,
    clientAuthentication: Schema.Literals([
      "client_secret_basic",
      "client_secret_post",
    ]),
    clientSecretFile: Schema.String,
    tokenEndpoint: HttpsUrl,
    subjectTokenAudience: Schema.String,
    secretProjection: SecretProjectionV1Schema,
  }),
  Schema.Struct({
    kind: Schema.Literals([
      "aws_workload_identity",
      "gcp_workload_identity",
    ]),
    ...DeliveryBaseFields,
    identityReference: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider_broker"),
    ...DeliveryBaseFields,
    brokerService: KubernetesName,
    flow: Schema.Literals(["github_app", "refresh_token"]),
    secretProjection: SecretProjectionV1Schema,
  }),
]);

export const ProviderCredentialPlanV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  credentialDomain: CredentialDomain,
  provider: AccessProviderIdSchema,
  policyEnforcement: Schema.Struct({
    service: Schema.Literal("agentos-egress-pep"),
    authenticateWith: Schema.Literal("pod_bound_service_account_token"),
    onDeny: Schema.Literal("do_not_forward"),
  }),
  policyDecision: Schema.Struct({
    service: Schema.Literal("agentos-egress-authz"),
    capability: AccessCapabilityIdSchema,
    resource: AuthorizationResourceV1Schema,
    consistency: Schema.Literal("strong"),
    output: Schema.Literal("bounded_decision_reference"),
  }),
  credentialDelivery: ProviderCredentialDeliveryV1Schema,
  isolation: Schema.Struct({
    adapterServiceAccount: KubernetesName,
    credentialDomain: CredentialDomain,
    acceptedRouteHosts: Schema.NonEmptyArray(DnsHost),
    secretCount: Schema.Literals([0, 1]),
    crossDomainCredentialAccess: Schema.Literal("none"),
  }),
  rotation: Schema.Struct({
    trigger: Schema.Literals([
      "secret_resource_version_change",
      "workload_identity_session_expiry",
    ]),
    reload: Schema.Literals([
      "rolling_restart_provider_adapter",
      "refresh_provider_identity_session",
    ]),
    replicas: Schema.Literal(2),
    maxUnavailable: Schema.Literal(0),
    agentRestart: Schema.Literal(false),
    maxStaleCredentialMillis: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
    ),
    terminateGracePeriodMillis: Schema.Literal(30_000),
    rollback: Schema.Literals([
      "restore_previous_secret_revision_and_roll_adapter",
      "rebind_previous_workload_identity_and_refresh_session",
    ]),
  }),
});

export const ProviderRouteOutcomeV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  outcome: Schema.Literals([
    "credential_unavailable",
    "credential_rejected",
    "credential_rotating",
    "credential_exchange_failed",
  ]),
  retryable: Schema.Boolean,
  correlationId: CorrelationId,
});

export const ProviderCredentialRouteStateInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  desiredResourceVersion: ResourceVersion,
  rotationStartedAtMillis: Schema.NullOr(EpochMillis),
  nowMillis: EpochMillis,
  correlationId: CorrelationId,
  status: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("loaded"),
      resourceVersion: ResourceVersion,
    }),
    Schema.Struct({ kind: Schema.Literal("missing") }),
    Schema.Struct({ kind: Schema.Literal("rejected") }),
    Schema.Struct({ kind: Schema.Literal("exchange_failed") }),
  ]),
});

export const ProviderCredentialReadyV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  outcome: Schema.Literal("credential_ready"),
  retryable: Schema.Literal(false),
  correlationId: CorrelationId,
});

export const ProviderCredentialRouteStateV1Schema = Schema.Union([
  ProviderCredentialReadyV1Schema,
  ProviderRouteOutcomeV1Schema,
]);

export const ProviderPolicyDecisionRequestV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  credentialDomain: CredentialDomain,
  provider: AccessProviderIdSchema,
  capability: AccessCapabilityIdSchema,
  resource: AuthorizationResourceV1Schema,
  subject: AuthorizationSubjectV1Schema,
});

export const ProviderPolicyDecisionRefV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  decisionRef: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^decision_[0-9a-f]{32}$/)),
  ),
  decision: Schema.Literals(["allow", "deny"]),
  credentialDomain: CredentialDomain,
  expiresAtMillis: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  profile: AccessProfileRefV1Schema,
  ceiling: AccessCeilingRefV1Schema,
  rateClass: AccessRateClassIdSchema,
});

const ProviderPolicyDecisionOutcome = Schema.Literals([
  "invalid_route",
  "identity_rejected",
  "database_unavailable",
  "policy_stale",
  "profile_denied",
  "ceiling_denied",
  "effective_policy_denied",
  "rate_class_disabled",
  "rate_class_exceeded",
  "rate_limited",
  "budget_exhausted",
  "openfga_unavailable",
  "decision_reference_unavailable",
]);

export class ProviderPolicyDecisionError extends Schema.TaggedErrorClass<ProviderPolicyDecisionError>()(
  "ProviderPolicyDecisionError",
  {
    outcome: ProviderPolicyDecisionOutcome,
    retryable: Schema.Boolean,
  },
) {}

export const ProviderEnforcementRequestV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  credentialDomain: CredentialDomain,
  identity: WorkloadIdentityV1Schema,
  requestHandle: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^request_[0-9a-f]{32}$/)),
  ),
});

export const ProviderForwardReceiptV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  correlationId: CorrelationId,
  credentialDomain: CredentialDomain,
  requestHandle: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^request_[0-9a-f]{32}$/)),
  ),
  outcome: Schema.Literal("forwarded"),
});

export const ProviderCredentialForwardRequestV1Schema = Schema.Struct({
  request: ProviderEnforcementRequestV1Schema,
  decision: ProviderPolicyDecisionRefV1Schema,
});

const ProviderCredentialPlanErrorCode = Schema.Literals([
  "invalid_contract",
  "provider_capability_mismatch",
  "provider_resource_mismatch",
  "duplicate_upstream_host",
  "secret_namespace_forbidden",
  "unsupported_identity_chain",
  "provider_broker_required",
]);

export class ProviderCredentialPlanError extends Schema.TaggedErrorClass<ProviderCredentialPlanError>()(
  "ProviderCredentialPlanError",
  {
    code: ProviderCredentialPlanErrorCode,
    boundary: Schema.Literals([
      "policy_enforcement",
      "policy_decision",
      "credential_delivery",
      "isolation",
    ]),
  },
) {}

export type ProviderSecretRefV1 = typeof ProviderSecretRefV1Schema.Type;
export type ProviderCredentialMechanismV1 =
  typeof ProviderCredentialMechanismV1Schema.Type;
export type ProviderCredentialPlanInput =
  typeof ProviderCredentialPlanInputSchema.Type;
export type ProviderCredentialDeliveryV1 =
  typeof ProviderCredentialDeliveryV1Schema.Type;
export type ProviderCredentialPlanV1 = typeof ProviderCredentialPlanV1Schema.Type;
export type ProviderRouteOutcomeV1 = typeof ProviderRouteOutcomeV1Schema.Type;
export type ProviderCredentialRouteStateInput =
  typeof ProviderCredentialRouteStateInputSchema.Type;
export type ProviderCredentialReadyV1 =
  typeof ProviderCredentialReadyV1Schema.Type;
export type ProviderCredentialRouteStateV1 =
  typeof ProviderCredentialRouteStateV1Schema.Type;
export type ProviderPolicyDecisionRequestV1 =
  typeof ProviderPolicyDecisionRequestV1Schema.Type;
export type ProviderPolicyDecisionRefV1 =
  typeof ProviderPolicyDecisionRefV1Schema.Type;
export type ProviderEnforcementRequestV1 =
  typeof ProviderEnforcementRequestV1Schema.Type;
export type ProviderForwardReceiptV1 =
  typeof ProviderForwardReceiptV1Schema.Type;
export type ProviderCredentialForwardRequestV1 =
  typeof ProviderCredentialForwardRequestV1Schema.Type;

export class ProviderPolicyEnforcementPoint extends Context.Service<
  ProviderPolicyEnforcementPoint,
  {
    readonly enforce: (
      request: ProviderEnforcementRequestV1,
    ) => Effect.Effect<ProviderPolicyDecisionRefV1, ProviderRouteOutcomeV1>;
  }
>()("agentos/access/ProviderPolicyEnforcementPoint") {}

export class ProviderPolicyDecisionPoint extends Context.Service<
  ProviderPolicyDecisionPoint,
  {
    readonly decide: (
      request: ProviderPolicyDecisionRequestV1,
    ) => Effect.Effect<
      ProviderPolicyDecisionRefV1,
      ProviderPolicyDecisionError
    >;
  }
>()("agentos/access/ProviderPolicyDecisionPoint") {}

export class ProviderCredentialDeliveryPoint extends Context.Service<
  ProviderCredentialDeliveryPoint,
  {
    readonly forward: (
      input: ProviderCredentialForwardRequestV1,
    ) => Effect.Effect<ProviderForwardReceiptV1, ProviderRouteOutcomeV1>;
  }
>()("agentos/access/ProviderCredentialDeliveryPoint") {}

const planError = (
  code: ProviderCredentialPlanError["code"],
  boundary: ProviderCredentialPlanError["boundary"],
) => ProviderCredentialPlanError.make({ code, boundary });

const providerForResource = (
  resource: ProviderCredentialPlanInput["resource"],
): ProviderCredentialPlanInput["provider"] => {
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
};

const secretRefForMechanism = (
  mechanism: ProviderCredentialMechanismV1,
): ProviderSecretRefV1 | null => {
  switch (mechanism.kind) {
    case "static_header":
    case "oauth_token_exchange":
    case "github_app":
    case "refresh_token":
      return mechanism.secretRef;
    case "aws_workload_identity":
    case "gcp_workload_identity":
    case "unsupported_native_client":
      return null;
  }
};

const secretProjection = (
  credentialDomain: string,
  secretRef: ProviderSecretRefV1,
): typeof SecretProjectionV1Schema.Type => ({
  secretRef,
  mountPath:
    `${AGENTOS_PROVIDER_CREDENTIAL_MOUNT_ROOT}/${credentialDomain}/credential`,
  mode: 0o440,
  readOnly: true,
});

interface CredentialDeliveryBaseV1 {
  readonly adapter: string;
  readonly forwardOnly: true;
  readonly returnsCredentialToCaller: false;
  readonly readiness: "credential_reference_loaded";
  readonly zeroization: "drop_request_scoped_material_after_forward";
}

const compileDelivery = (
  adapter: string,
  credentialDomain: string,
  mechanism: ProviderCredentialMechanismV1,
): Effect.Effect<ProviderCredentialDeliveryV1, ProviderCredentialPlanError> => {
  const base: CredentialDeliveryBaseV1 = {
    adapter,
    forwardOnly: true,
    returnsCredentialToCaller: false,
    readiness: "credential_reference_loaded",
    zeroization: "drop_request_scoped_material_after_forward",
  };
  switch (mechanism.kind) {
    case "static_header": {
      const projection = secretProjection(
        credentialDomain,
        mechanism.secretRef,
      );
      return Effect.succeed<ProviderCredentialDeliveryV1>({
        kind: "agentgateway_static_header",
        ...base,
        headerName: mechanism.headerName,
        prefix: mechanism.prefix,
        valueFile: projection.mountPath,
        secretProjection: projection,
      });
    }
    case "oauth_token_exchange": {
      if (!mechanism.upstreamSupportsTokenExchange) {
        return Effect.fail(
          planError("unsupported_identity_chain", "credential_delivery"),
        );
      }
      const projection = secretProjection(
        credentialDomain,
        mechanism.secretRef,
      );
      return Effect.succeed<ProviderCredentialDeliveryV1>({
        kind: "agentgateway_oauth_token_exchange",
        ...base,
        clientId: mechanism.clientId,
        clientAuthentication: mechanism.clientAuthentication,
        clientSecretFile: projection.mountPath,
        tokenEndpoint: mechanism.tokenEndpoint,
        subjectTokenAudience: mechanism.subjectTokenAudience,
        secretProjection: projection,
      });
    }
    case "aws_workload_identity":
      return Effect.succeed<ProviderCredentialDeliveryV1>({
        kind: mechanism.kind,
        ...base,
        identityReference: mechanism.roleArn,
      });
    case "gcp_workload_identity":
      return Effect.succeed<ProviderCredentialDeliveryV1>({
        kind: mechanism.kind,
        ...base,
        identityReference: mechanism.audience,
      });
    case "github_app":
    case "refresh_token":
      return Effect.succeed<ProviderCredentialDeliveryV1>({
        kind: "provider_broker",
        ...base,
        brokerService: mechanism.brokerService,
        flow: mechanism.kind,
        secretProjection: secretProjection(
          credentialDomain,
          mechanism.secretRef,
        ),
      });
    case "unsupported_native_client":
      return Effect.fail(
        planError("provider_broker_required", "credential_delivery"),
      );
  }
};

export const compileProviderCredentialPlan = Effect.fn(
  "ProviderCredentialDelivery.compilePlan",
)(function* (untrusted: unknown) {
  const input = yield* Schema.decodeUnknownEffect(
    ProviderCredentialPlanInputSchema,
    { onExcessProperty: "error" },
  )(untrusted).pipe(
    Effect.mapError(() => planError("invalid_contract", "policy_enforcement")),
  );

  if (
    input.capability !== "provider.secret.use" &&
    !input.capability.startsWith(`${input.provider}.`)
  ) {
    return yield* Effect.fail(
      planError("provider_capability_mismatch", "policy_decision"),
    );
  }
  if (providerForResource(input.resource) !== input.provider) {
    return yield* Effect.fail(
      planError("provider_resource_mismatch", "policy_decision"),
    );
  }
  if (new Set(input.upstreamHosts).size !== input.upstreamHosts.length) {
    return yield* Effect.fail(
      planError("duplicate_upstream_host", "isolation"),
    );
  }

  const secretRef = secretRefForMechanism(input.mechanism);
  if (
    secretRef !== null &&
    secretRef.namespace !== AGENTOS_PROVIDER_CREDENTIAL_NAMESPACE
  ) {
    return yield* Effect.fail(
      planError("secret_namespace_forbidden", "isolation"),
    );
  }

  const adapter = `agentgateway-${input.credentialDomain}`;
  const delivery = yield* compileDelivery(
    adapter,
    input.credentialDomain,
    input.mechanism,
  );
  const usesSecret = secretRef !== null;

  const rotation: ProviderCredentialPlanV1["rotation"] = usesSecret
    ? {
        trigger: "secret_resource_version_change",
        reload: "rolling_restart_provider_adapter",
        replicas: 2,
        maxUnavailable: 0,
        agentRestart: false,
        maxStaleCredentialMillis:
          AGENTOS_PROVIDER_CREDENTIAL_MAX_STALE_MILLIS,
        terminateGracePeriodMillis: 30_000,
        rollback: "restore_previous_secret_revision_and_roll_adapter",
      }
    : {
        trigger: "workload_identity_session_expiry",
        reload: "refresh_provider_identity_session",
        replicas: 2,
        maxUnavailable: 0,
        agentRestart: false,
        maxStaleCredentialMillis: 3_600_000,
        terminateGracePeriodMillis: 30_000,
        rollback: "rebind_previous_workload_identity_and_refresh_session",
      };

  const plan: ProviderCredentialPlanV1 = {
    schemaVersion: 1,
    credentialDomain: input.credentialDomain,
    provider: input.provider,
    policyEnforcement: {
      service: "agentos-egress-pep",
      authenticateWith: "pod_bound_service_account_token",
      onDeny: "do_not_forward",
    },
    policyDecision: {
      service: "agentos-egress-authz",
      capability: input.capability,
      resource: input.resource,
      consistency: "strong",
      output: "bounded_decision_reference",
    },
    credentialDelivery: delivery,
    isolation: {
      adapterServiceAccount: adapter,
      credentialDomain: input.credentialDomain,
      acceptedRouteHosts: input.upstreamHosts,
      secretCount: usesSecret ? 1 : 0,
      crossDomainCredentialAccess: "none",
    },
    rotation,
  };

  return yield* Schema.decodeUnknownEffect(ProviderCredentialPlanV1Schema, {
    onExcessProperty: "error",
  })(plan).pipe(
    Effect.mapError(() => planError("invalid_contract", "credential_delivery")),
  );
});

const providerRouteOutcome = (
  input: ProviderCredentialRouteStateInput,
  outcome: ProviderRouteOutcomeV1["outcome"],
  retryable: boolean,
): ProviderRouteOutcomeV1 => ({
  schemaVersion: 1,
  provider: input.provider,
  credentialDomain: input.credentialDomain,
  outcome,
  retryable,
  correlationId: input.correlationId,
});

export const resolveProviderCredentialRouteState = Effect.fn(
  "ProviderCredentialDelivery.resolveRouteState",
)(function* (untrusted: unknown) {
  const input = yield* Schema.decodeUnknownEffect(
    ProviderCredentialRouteStateInputSchema,
    { onExcessProperty: "error" },
  )(untrusted).pipe(
    Effect.mapError(() => planError("invalid_contract", "credential_delivery")),
  );

  if (
    input.rotationStartedAtMillis !== null &&
    input.rotationStartedAtMillis > input.nowMillis
  ) {
    return yield* Effect.fail(
      planError("invalid_contract", "credential_delivery"),
    );
  }

  switch (input.status.kind) {
    case "missing":
      return providerRouteOutcome(input, "credential_unavailable", true);
    case "rejected":
      return providerRouteOutcome(input, "credential_rejected", false);
    case "exchange_failed":
      return providerRouteOutcome(input, "credential_exchange_failed", true);
    case "loaded":
      if (input.status.resourceVersion === input.desiredResourceVersion) {
        const ready: ProviderCredentialReadyV1 = {
          schemaVersion: 1,
          provider: input.provider,
          credentialDomain: input.credentialDomain,
          outcome: "credential_ready",
          retryable: false,
          correlationId: input.correlationId,
        };
        return ready;
      }
      if (
        input.rotationStartedAtMillis !== null &&
        input.nowMillis - input.rotationStartedAtMillis <
          AGENTOS_PROVIDER_CREDENTIAL_MAX_STALE_MILLIS
      ) {
        return providerRouteOutcome(input, "credential_rotating", true);
      }
      return providerRouteOutcome(input, "credential_unavailable", true);
  }
});
