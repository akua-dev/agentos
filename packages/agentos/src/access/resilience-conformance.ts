import { Effect, FileSystem, Path, Schema } from "effect";

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

export const ACCESS_RESILIENCE_SCENARIOS = values(
  "identity.impersonation_denied",
  "identity.wrong_audience",
  "identity.expired_token",
  "identity.stale_pod_uid",
  "identity.deleted_pod",
  "identity.stale_serviceaccount_uid",
  "identity.deleted_serviceaccount",
  "identity.assignment_ended",
  "identity.exact_custody",
  "authorization.profile_allow",
  "authorization.scope_mismatch",
  "authorization.profile_rebind",
  "authorization.binding_revocation",
  "authorization.ceiling_shrink",
  "authorization.openfga_consistency",
  "authorization.rate_effective_zero",
  "authorization.budget_kill_switch",
  "authorization.unrelated_subject_continuity",
  "dependency.tokenreview_outage",
  "dependency.postgresql_outage",
  "dependency.openfga_outage",
  "dependency.authorizer_outage",
  "dependency.agentgateway_outage",
  "dependency.provider_adapter_outage",
  "credential.provider_expiry_refresh",
  "credential.projected_token_rotation",
  "transport.bounded_retry",
  "transport.stream_completion",
  "transport.cancellation",
  "transport.failure",
  "settlement.exactly_once",
  "internet.ordinary_continuity",
  "native.github_rest",
  "native.github_graphql",
  "native.git_smart_http",
  "native.git_projected_identity",
  "native.gh_projected_identity",
  "native.gh_axi_projected_identity",
);

export const DISPOSABLE_ACCESS_RESILIENCE_SCENARIOS = values(
  "identity.wrong_audience",
  "identity.stale_pod_uid",
  "identity.deleted_pod",
  "identity.stale_serviceaccount_uid",
  "identity.deleted_serviceaccount",
  "authorization.profile_rebind",
  "authorization.binding_revocation",
  "authorization.unrelated_subject_continuity",
  "credential.projected_token_rotation",
  "internet.ordinary_continuity",
);

const PgliteAccessScenarios = values(
  "identity.assignment_ended",
  "authorization.profile_allow",
  "authorization.scope_mismatch",
  "authorization.ceiling_shrink",
  "authorization.openfga_consistency",
  "authorization.rate_effective_zero",
  "authorization.budget_kill_switch",
  "dependency.postgresql_outage",
  "settlement.exactly_once",
);

export const AccessResilienceScenarioIdSchema = Schema.Literals(
  ACCESS_RESILIENCE_SCENARIOS,
);
const SourceSchema = Schema.Literals([
  "effect_fixture",
  "pglite",
  "disposable_kubernetes",
]);
const StatusSchema = Schema.Literals(["observed", "unobserved", "failed"]);
const OutcomeSchema = Schema.Literals([
  "allowed",
  "denied",
  "dependency_unavailable",
  "completed",
  "cancelled",
  "provider_failed",
  "bypassed",
]);
const FailureClassSchema = Schema.Literals([
  "none",
  "impersonation",
  "audience_mismatch",
  "token_expired",
  "pod_uid_mismatch",
  "pod_deleted",
  "serviceaccount_uid_mismatch",
  "serviceaccount_deleted",
  "assignment_inactive",
  "scope_mismatch",
  "binding_revoked",
  "ceiling_denied",
  "consistency_denied",
  "rate_disabled",
  "budget_exhausted",
  "tokenreview_unavailable",
  "postgresql_unavailable",
  "openfga_unavailable",
  "authorizer_unavailable",
  "agentgateway_unavailable",
  "provider_adapter_unavailable",
  "provider_authentication",
  "retry_exhausted",
  "stream_failed",
  "cancelled",
  "transport_failed",
]);
const RecoverySchema = Schema.Literals([
  "not_required",
  "projection_refresh",
  "policy_hot_reload",
  "credential_refresh",
  "dependency_recovery",
  "bounded_retry",
  "stream_settlement",
  "internet_bypass",
]);
const NativeClientSchema = Schema.Literals(["none", "git", "gh", "gh-axi"]);
const ObservedContentSchema = Schema.Literals([
  "serviceaccount_token",
  "provider_credential",
  "request_body",
  "response_body",
  "git_payload",
  "tool_payload",
  "provider_identity",
]);
const MetricDimensionSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9_]*$/),
  ),
);
const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const RevisionSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
);
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
);
const ImageSchema = Schema.Struct({
  name: Schema.Literals([
    "agentos",
    "agentgateway",
    "openfga",
    "postgresql",
    "kubernetes-node",
  ]),
  digest: DigestSchema,
});
const DisposableEnvironmentSchema = Schema.Struct({
  isolation: Schema.Literal("disposable"),
  context: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^(?:kind|vcluster)-[a-z0-9-]+$/),
    ),
  ),
  approvalReference: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^approval:[0-9A-Za-z._:-]+$/),
    ),
  ),
  productionEndpointContacted: Schema.Boolean,
  destroyedAfterRun: Schema.Boolean,
});

export const AccessResilienceObservationV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  scenario: AccessResilienceScenarioIdSchema,
  source: SourceSchema,
  status: StatusSchema,
  outcome: OutcomeSchema,
  failureClass: FailureClassSchema,
  recovery: RecoverySchema,
  elapsedMillis: NonNegativeIntegerSchema,
  revocationMillis: Schema.NullOr(NonNegativeIntegerSchema),
  hotReloadMillis: Schema.NullOr(NonNegativeIntegerSchema),
  load: Schema.Struct({
    attempts: NonNegativeIntegerSchema,
    allowed: NonNegativeIntegerSchema,
    denied: NonNegativeIntegerSchema,
    providerForwards: NonNegativeIntegerSchema,
    settlements: NonNegativeIntegerSchema,
  }),
  enforcement: Schema.Struct({
    providerAdapterReached: Schema.Boolean,
    credentialReleased: Schema.Boolean,
    unrelatedSubjectAllowed: Schema.NullOr(Schema.Boolean),
    ordinaryInternetAllowed: Schema.NullOr(Schema.Boolean),
  }),
  native: Schema.Struct({
    client: NativeClientSchema,
    projectedTokenReread: Schema.NullOr(Schema.Boolean),
    persistedLogin: Schema.NullOr(Schema.Boolean),
    statusPreserved: Schema.NullOr(Schema.Boolean),
    streamPreserved: Schema.NullOr(Schema.Boolean),
    stderrPreserved: Schema.NullOr(Schema.Boolean),
    exitCodePreserved: Schema.NullOr(Schema.Boolean),
  }),
  audit: Schema.Struct({
    complete: Schema.Boolean,
    protected: Schema.Boolean,
    eventCount: NonNegativeIntegerSchema,
    metricDimensions: Schema.Array(MetricDimensionSchema).pipe(
      Schema.check(Schema.isMaxLength(8)),
    ),
    observedContent: Schema.Array(ObservedContentSchema).pipe(
      Schema.check(Schema.isMaxLength(7)),
    ),
  }),
});

export const AccessResilienceRunV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  revision: RevisionSchema,
  environment: DisposableEnvironmentSchema,
  images: Schema.Array(ImageSchema).pipe(
    Schema.check(Schema.isMinLength(5), Schema.isMaxLength(5)),
  ),
  observations: Schema.Array(AccessResilienceObservationV1Schema).pipe(
    Schema.check(Schema.isMaxLength(ACCESS_RESILIENCE_SCENARIOS.length + 1)),
  ),
});

export type AccessResilienceScenarioId =
  typeof AccessResilienceScenarioIdSchema.Type;
export type AccessResilienceObservationV1 =
  typeof AccessResilienceObservationV1Schema.Type;
export type AccessResilienceRunV1 = typeof AccessResilienceRunV1Schema.Type;

export interface AccessResilienceScenarioDefinition {
  readonly outcome: typeof OutcomeSchema.Type;
  readonly failureClass: typeof FailureClassSchema.Type;
  readonly recovery: typeof RecoverySchema.Type;
  readonly minimumSource: typeof SourceSchema.Type;
  readonly requiresRevocationSlo: boolean;
  readonly requiresHotReloadSlo: boolean;
  readonly requiresLoad: boolean;
  readonly providerForwardExpected: boolean;
  readonly credentialReleaseExpected: boolean;
  readonly settlementExpected: boolean;
  readonly requiresUnrelatedContinuity: boolean;
  readonly requiresInternetContinuity: boolean;
  readonly requiresNativeSemantics: boolean;
  readonly nativeClient: typeof NativeClientSchema.Type;
}

type DefinitionOptions = Partial<
  Omit<
    AccessResilienceScenarioDefinition,
    "outcome" | "failureClass" | "recovery" | "minimumSource"
  >
>;

function definition(
  scenario: AccessResilienceScenarioId,
  outcome: typeof OutcomeSchema.Type,
  failureClass: typeof FailureClassSchema.Type,
  recovery: typeof RecoverySchema.Type,
  options: DefinitionOptions = {},
): AccessResilienceScenarioDefinition {
  return {
    outcome,
    failureClass,
    recovery,
    minimumSource: DISPOSABLE_ACCESS_RESILIENCE_SCENARIOS.some((candidate) =>
        candidate === scenario
      )
      ? "disposable_kubernetes"
      : PgliteAccessScenarios.some((candidate) => candidate === scenario)
      ? "pglite"
      : "effect_fixture",
    requiresRevocationSlo: false,
    requiresHotReloadSlo: false,
    requiresLoad: false,
    providerForwardExpected: false,
    credentialReleaseExpected: false,
    settlementExpected: false,
    requiresUnrelatedContinuity: false,
    requiresInternetContinuity: false,
    requiresNativeSemantics: false,
    nativeClient: "none",
    ...options,
  };
}

export function accessResilienceScenarioDefinition(
  scenario: AccessResilienceScenarioId,
): AccessResilienceScenarioDefinition {
  switch (scenario) {
    case "identity.impersonation_denied":
      return definition(scenario, "denied", "impersonation", "not_required");
    case "identity.wrong_audience":
      return definition(scenario, "denied", "audience_mismatch", "not_required");
    case "identity.expired_token":
      return definition(scenario, "denied", "token_expired", "projection_refresh");
    case "identity.stale_pod_uid":
      return definition(scenario, "denied", "pod_uid_mismatch", "projection_refresh", {
        requiresRevocationSlo: true,
        requiresLoad: true,
      });
    case "identity.deleted_pod":
      return definition(scenario, "denied", "pod_deleted", "projection_refresh", {
        requiresRevocationSlo: true,
        requiresLoad: true,
      });
    case "identity.stale_serviceaccount_uid":
      return definition(
        scenario,
        "denied",
        "serviceaccount_uid_mismatch",
        "projection_refresh",
        { requiresRevocationSlo: true, requiresLoad: true },
      );
    case "identity.deleted_serviceaccount":
      return definition(
        scenario,
        "denied",
        "serviceaccount_deleted",
        "projection_refresh",
        { requiresRevocationSlo: true, requiresLoad: true },
      );
    case "identity.assignment_ended":
      return definition(scenario, "denied", "assignment_inactive", "policy_hot_reload", {
        requiresRevocationSlo: true,
        requiresHotReloadSlo: true,
        requiresLoad: true,
      });
    case "identity.exact_custody":
      return definition(scenario, "allowed", "none", "not_required");
    case "authorization.profile_allow":
      return definition(scenario, "allowed", "none", "not_required");
    case "authorization.scope_mismatch":
      return definition(scenario, "denied", "scope_mismatch", "not_required");
    case "authorization.profile_rebind":
      return definition(scenario, "allowed", "none", "policy_hot_reload", {
        requiresHotReloadSlo: true,
        requiresLoad: true,
        requiresUnrelatedContinuity: true,
      });
    case "authorization.binding_revocation":
      return definition(scenario, "denied", "binding_revoked", "policy_hot_reload", {
        requiresRevocationSlo: true,
        requiresHotReloadSlo: true,
        requiresLoad: true,
        requiresUnrelatedContinuity: true,
      });
    case "authorization.ceiling_shrink":
      return definition(scenario, "denied", "ceiling_denied", "policy_hot_reload", {
        requiresRevocationSlo: true,
        requiresHotReloadSlo: true,
        requiresLoad: true,
      });
    case "authorization.openfga_consistency":
      return definition(scenario, "denied", "consistency_denied", "policy_hot_reload", {
        requiresHotReloadSlo: true,
        requiresLoad: true,
      });
    case "authorization.rate_effective_zero":
      return definition(scenario, "denied", "rate_disabled", "policy_hot_reload", {
        requiresHotReloadSlo: true,
        requiresLoad: true,
      });
    case "authorization.budget_kill_switch":
      return definition(scenario, "denied", "budget_exhausted", "policy_hot_reload", {
        requiresHotReloadSlo: true,
        requiresLoad: true,
      });
    case "authorization.unrelated_subject_continuity":
      return definition(scenario, "allowed", "none", "policy_hot_reload", {
        requiresHotReloadSlo: true,
        requiresLoad: true,
        requiresUnrelatedContinuity: true,
      });
    case "dependency.tokenreview_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "tokenreview_unavailable",
        "dependency_recovery",
      );
    case "dependency.postgresql_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "postgresql_unavailable",
        "dependency_recovery",
      );
    case "dependency.openfga_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "openfga_unavailable",
        "dependency_recovery",
      );
    case "dependency.authorizer_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "authorizer_unavailable",
        "dependency_recovery",
      );
    case "dependency.agentgateway_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "agentgateway_unavailable",
        "dependency_recovery",
      );
    case "dependency.provider_adapter_outage":
      return definition(
        scenario,
        "dependency_unavailable",
        "provider_adapter_unavailable",
        "dependency_recovery",
      );
    case "credential.provider_expiry_refresh":
      return definition(scenario, "completed", "provider_authentication", "credential_refresh", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
      });
    case "credential.projected_token_rotation":
      return definition(scenario, "completed", "none", "projection_refresh");
    case "transport.bounded_retry":
      return definition(scenario, "completed", "retry_exhausted", "bounded_retry", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
      });
    case "transport.stream_completion":
      return definition(scenario, "completed", "none", "stream_settlement", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
        settlementExpected: true,
        requiresNativeSemantics: true,
      });
    case "transport.cancellation":
      return definition(scenario, "cancelled", "cancelled", "stream_settlement", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
        settlementExpected: true,
      });
    case "transport.failure":
      return definition(scenario, "provider_failed", "transport_failed", "stream_settlement", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
        settlementExpected: true,
      });
    case "settlement.exactly_once":
      return definition(scenario, "completed", "none", "stream_settlement", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
        settlementExpected: true,
      });
    case "internet.ordinary_continuity":
      return definition(scenario, "bypassed", "none", "internet_bypass", {
        requiresInternetContinuity: true,
      });
    case "native.github_rest":
    case "native.github_graphql":
    case "native.git_smart_http":
      return definition(scenario, "completed", "none", "stream_settlement", {
        providerForwardExpected: true,
        credentialReleaseExpected: true,
        settlementExpected: true,
        requiresNativeSemantics: true,
      });
    case "native.git_projected_identity":
      return nativeClientDefinition(scenario, "git");
    case "native.gh_projected_identity":
      return nativeClientDefinition(scenario, "gh");
    case "native.gh_axi_projected_identity":
      return nativeClientDefinition(scenario, "gh-axi");
  }
}

function nativeClientDefinition(
  scenario: AccessResilienceScenarioId,
  nativeClient: "git" | "gh" | "gh-axi",
) {
  return definition(scenario, "completed", "none", "stream_settlement", {
    providerForwardExpected: true,
    credentialReleaseExpected: true,
    settlementExpected: true,
    requiresNativeSemantics: true,
    nativeClient,
  });
}

const RequiredImages = values(
  "agentos",
  "agentgateway",
  "openfga",
  "postgresql",
  "kubernetes-node",
);
const AllowedMetricDimensions = values(
  "operation",
  "outcome",
  "failure_class",
  "dependency",
  "credential_outcome",
);
export const ACCESS_REVOCATION_SLO_MILLIS = 60_000;
export const ACCESS_HOT_RELOAD_SLO_MILLIS = 15_000;
export const ACCESS_MINIMUM_LOAD_ATTEMPTS = 16;

const GateErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "production_boundary_contacted",
  "disposable_cleanup_missing",
  "image_pin_missing",
  "scenario_missing",
  "scenario_duplicate",
  "scenario_unobserved",
  "scenario_failed",
  "outcome_mismatch",
  "evidence_too_weak",
  "revocation_slo_exceeded",
  "hot_reload_slo_exceeded",
  "load_evidence_missing",
  "load_evidence_mismatch",
  "denial_reached_adapter",
  "denial_released_credential",
  "provider_forward_mismatch",
  "settlement_mismatch",
  "unrelated_subject_disrupted",
  "internet_independence_missing",
  "native_client_violation",
  "audit_incomplete",
  "audit_not_protected",
  "content_leak",
  "metric_cardinality_violation",
]);

export class AccessResilienceGateError extends Schema.TaggedErrorClass<AccessResilienceGateError>()(
  "AccessResilienceGateError",
  {
    code: GateErrorCodeSchema,
    scenario: Schema.NullOr(AccessResilienceScenarioIdSchema),
  },
) {}

export const compileAccessResilienceVerdict = Effect.fn(
  "agentos.access.compileResilienceVerdict",
)(function*(input: unknown) {
  const run = yield* Schema.decodeUnknownEffect(AccessResilienceRunV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() => gateError("invalid_contract", null)),
  );
  if (run.environment.productionEndpointContacted) {
    return yield* gateError("production_boundary_contacted", null);
  }
  if (!run.environment.destroyedAfterRun) {
    return yield* gateError("disposable_cleanup_missing", null);
  }
  for (const name of RequiredImages) {
    if (run.images.filter((image) => image.name === name).length !== 1) {
      return yield* gateError("image_pin_missing", null);
    }
  }
  for (const scenario of ACCESS_RESILIENCE_SCENARIOS) {
    const matches = run.observations.filter((item) => item.scenario === scenario);
    if (matches.length === 0) return yield* gateError("scenario_missing", scenario);
    if (matches.length !== 1) return yield* gateError("scenario_duplicate", scenario);
    const observed = matches[0];
    if (observed === undefined) return yield* gateError("scenario_missing", scenario);
    if (observed.status === "unobserved") {
      return yield* gateError("scenario_unobserved", scenario);
    }
    if (observed.status === "failed") {
      return yield* gateError("scenario_failed", scenario);
    }
    const expected = accessResilienceScenarioDefinition(scenario);
    if (
      observed.outcome !== expected.outcome ||
      observed.failureClass !== expected.failureClass ||
      observed.recovery !== expected.recovery
    ) return yield* gateError("outcome_mismatch", scenario);
    if (sourceStrength(observed.source) < sourceStrength(expected.minimumSource)) {
      return yield* gateError("evidence_too_weak", scenario);
    }
    if (
      expected.requiresRevocationSlo &&
      (observed.revocationMillis === null ||
        observed.revocationMillis > ACCESS_REVOCATION_SLO_MILLIS)
    ) return yield* gateError("revocation_slo_exceeded", scenario);
    if (
      expected.requiresHotReloadSlo &&
      (observed.hotReloadMillis === null ||
        observed.hotReloadMillis > ACCESS_HOT_RELOAD_SLO_MILLIS)
    ) return yield* gateError("hot_reload_slo_exceeded", scenario);
    if (expected.requiresLoad && observed.load.attempts < ACCESS_MINIMUM_LOAD_ATTEMPTS) {
      return yield* gateError("load_evidence_missing", scenario);
    }
    if (observed.load.allowed + observed.load.denied !== observed.load.attempts) {
      return yield* gateError("load_evidence_mismatch", scenario);
    }
    const denied = observed.outcome === "denied" ||
      observed.outcome === "dependency_unavailable";
    if (denied && (observed.enforcement.providerAdapterReached || observed.load.providerForwards > 0)) {
      return yield* gateError("denial_reached_adapter", scenario);
    }
    if (denied && observed.enforcement.credentialReleased) {
      return yield* gateError("denial_released_credential", scenario);
    }
    if (
      observed.enforcement.providerAdapterReached !== expected.providerForwardExpected ||
      (expected.providerForwardExpected && observed.load.providerForwards !== observed.load.attempts) ||
      (!expected.providerForwardExpected && observed.load.providerForwards !== 0)
    ) return yield* gateError("provider_forward_mismatch", scenario);
    if (observed.enforcement.credentialReleased !== expected.credentialReleaseExpected) {
      return yield* gateError(
        denied ? "denial_released_credential" : "provider_forward_mismatch",
        scenario,
      );
    }
    if (
      (expected.settlementExpected && observed.load.settlements !== observed.load.attempts) ||
      (!expected.settlementExpected && observed.load.settlements !== 0)
    ) return yield* gateError("settlement_mismatch", scenario);
    if (
      expected.requiresUnrelatedContinuity &&
      observed.enforcement.unrelatedSubjectAllowed !== true
    ) return yield* gateError("unrelated_subject_disrupted", scenario);
    if (
      expected.requiresInternetContinuity &&
      observed.enforcement.ordinaryInternetAllowed !== true
    ) return yield* gateError("internet_independence_missing", scenario);
    if (!validNativeEvidence(observed, expected)) {
      return yield* gateError("native_client_violation", scenario);
    }
    if (!observed.audit.complete || observed.audit.eventCount < 1) {
      return yield* gateError("audit_incomplete", scenario);
    }
    if (!observed.audit.protected) {
      return yield* gateError("audit_not_protected", scenario);
    }
    if (observed.audit.observedContent.length !== 0) {
      return yield* gateError("content_leak", scenario);
    }
    if (
      observed.audit.metricDimensions.some((dimension) =>
        !AllowedMetricDimensions.some((allowed) => allowed === dimension)
      ) ||
      new Set(observed.audit.metricDimensions).size !==
        observed.audit.metricDimensions.length
    ) return yield* gateError("metric_cardinality_violation", scenario);
  }
  const effectFixtureCount = run.observations.filter((item) =>
    item.source === "effect_fixture"
  ).length;
  const pgliteCount = run.observations.filter((item) => item.source === "pglite").length;
  const disposableKubernetesCount = run.observations.filter((item) =>
    item.source === "disposable_kubernetes"
  ).length;
  return {
    version: 1,
    eligible: true,
    scenarioCount: run.observations.length,
    effectFixtureCount,
    pgliteCount,
    disposableKubernetesCount,
    revocationSloMillis: ACCESS_REVOCATION_SLO_MILLIS,
    hotReloadSloMillis: ACCESS_HOT_RELOAD_SLO_MILLIS,
    minimumLoadAttempts: ACCESS_MINIMUM_LOAD_ATTEMPTS,
    providerCredentialAuthority: "provider_adapter",
    ordinaryInternetPath: "direct",
  };
});

function validNativeEvidence(
  observed: AccessResilienceObservationV1,
  expected: AccessResilienceScenarioDefinition,
) {
  if (expected.nativeClient === "none" && !expected.requiresNativeSemantics) {
    return observed.native.client === "none" &&
      observed.native.projectedTokenReread === null &&
      observed.native.persistedLogin === null &&
      observed.native.statusPreserved === null &&
      observed.native.streamPreserved === null &&
      observed.native.stderrPreserved === null &&
      observed.native.exitCodePreserved === null;
  }
  if (
    observed.native.client !== expected.nativeClient ||
    observed.native.statusPreserved !== true ||
    observed.native.streamPreserved !== true ||
    observed.native.stderrPreserved !== true ||
    observed.native.exitCodePreserved !== true
  ) return false;
  return expected.nativeClient === "none" ||
    (observed.native.projectedTokenReread === true &&
      observed.native.persistedLogin === false);
}

function sourceStrength(source: typeof SourceSchema.Type) {
  switch (source) {
    case "effect_fixture":
      return 1;
    case "pglite":
      return 2;
    case "disposable_kubernetes":
      return 3;
  }
}

function gateError(
  code: AccessResilienceGateError["code"],
  scenario: AccessResilienceScenarioId | null,
) {
  return AccessResilienceGateError.make({ code, scenario });
}

const RegressionKindSchema = Schema.Literals(["original", "held_out"]);
export const AccessResilienceRegressionSourceV1Schema = Schema.Struct({
  scenario: AccessResilienceScenarioIdSchema,
  kind: RegressionKindSchema,
  issue: Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9]+$/))),
  path: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(256),
      Schema.isPattern(
        /^(?:database|packages|services)\/[0-9A-Za-z._/-]+\.effect\.test\.ts$/,
      ),
    ),
  ),
  title: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});
export type AccessResilienceRegressionSourceV1 =
  typeof AccessResilienceRegressionSourceV1Schema.Type;

interface RegressionTest {
  readonly issue: AccessResilienceRegressionSourceV1["issue"];
  readonly path: AccessResilienceRegressionSourceV1["path"];
  readonly title: AccessResilienceRegressionSourceV1["title"];
}

function regressionTest(path: string, title: string, issue: `#${number}`): RegressionTest {
  return { path, title, issue };
}

function regressionPair(
  scenario: AccessResilienceScenarioId,
  original: RegressionTest,
  heldOut: RegressionTest,
): ReadonlyArray<AccessResilienceRegressionSourceV1> {
  return [
    { scenario, kind: "original", ...original },
    { scenario, kind: "held_out", ...heldOut },
  ];
}

const IdentityExact = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "derives one exact live Mate and active Assignment",
  "#92",
);
const AccessLive = regressionTest(
  "packages/agentos/src/access/tests/disposable-kubernetes.effect.test.ts",
  "proves live bound identity, revocation and direct Internet independence under load",
  "#92",
);
const IdentityAudience = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "requires the dedicated audience and exact live bound UIDs",
  "#92",
);
const IdentityImpersonation = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "does not let a second Pod reuse a shared ServiceAccount identity",
  "#92",
);
const IdentityInactive = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "fails closed for inactive or ambiguous Agent and Assignment state",
  "#92",
);
const IdentityExpiry = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "caps positive caching, honors token expiry, and invalidates by identity",
  "#92",
);
const IdentityUnavailable = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "never turns TokenReview or identity-store unavailability into identity",
  "#92",
);
const KubernetesObjects = regressionTest(
  "packages/agentos/src/access/tests/kubernetes-identity-http.effect.test.ts",
  "normalizes live Pod and ServiceAccount objects and treats only 404 as absence",
  "#92",
);
const KubernetesRotation = regressionTest(
  "packages/agentos/src/access/tests/kubernetes-identity-http.effect.test.ts",
  "rereads the client token and sends the exact TokenReview contract",
  "#92",
);
const KubernetesFailures = regressionTest(
  "packages/agentos/src/access/tests/kubernetes-identity-http.effect.test.ts",
  "keeps status, malformed, oversized, and credential failures typed and secret-free",
  "#92",
);
const PostgresIdentity = regressionTest(
  "packages/agentos/src/access/tests/postgres-identity.effect.test.ts",
  "decodes exact workload, Assignment, and immutable policy snapshots",
  "#92",
);
const PostgresFailure = regressionTest(
  "packages/agentos/src/access/tests/postgres-identity.effect.test.ts",
  "returns attributable content-free database and schema failures",
  "#92",
);
const PostgresRecovery = regressionTest(
  "packages/agentos/src/access/tests/postgres-identity.effect.test.ts",
  "recovers after pool starvation or a database restart",
  "#92",
);
const PolicyAllow = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "requires profile, ceiling, and effective allow at the pinned model",
  "#92",
);
const PolicyRoute = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "rejects caller-controlled identity and invalid provider routes before dependencies",
  "#92",
);
const PolicyDenials = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "distinguishes permission, rate, and OpenFGA denials",
  "#92",
);
const PolicyBudget = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "keeps budget exhaustion distinct from provider and policy failures",
  "#92",
);
const PolicyOpenFgaFailure = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "maps OpenFGA dependency failure without leaking request content",
  "#92",
);
const PolicyNoForward = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "never reaches provider forwarding after denial and preserves interruption",
  "#92",
);
const ControlCeiling = regressionTest(
  "packages/agentos/src/access/tests/control-plane.effect.test.ts",
  "reconciles a ceiling shrink without retaining the removed grant",
  "#92",
);
const OpenFgaIsolation = regressionTest(
  "packages/agentos/src/access/tests/openfga.effect.test.ts",
  "uses separate targets and membership paths across Fleets",
  "#92",
);
const OpenFgaMutation = regressionTest(
  "packages/agentos/src/access/tests/openfga.effect.test.ts",
  "removes revoked bindings and atomically replaces a shrunken ceiling",
  "#92",
);
const OpenFgaConsistency = regressionTest(
  "packages/agentos/src/access/tests/openfga.effect.test.ts",
  "acknowledges mutations only after a pinned higher-consistency check",
  "#92",
);
const OpenFgaReadiness = regressionTest(
  "packages/agentos/src/access/tests/openfga-http.effect.test.ts",
  "reuses the exact immutable model and verifies canonical readiness strongly",
  "#92",
);
const DatabaseProfile = regressionTest(
  "database/tests/access-control-plane.effect.test.ts",
  "publishes one immutable profile version idempotently",
  "#92",
);
const DatabaseBinding = regressionTest(
  "database/tests/access-control-plane.effect.test.ts",
  "keeps a binding active until verified revocation completes",
  "#92",
);
const DatabaseAssignment = regressionTest(
  "database/tests/access-control-plane.effect.test.ts",
  "supports an exact active Assignment subject",
  "#92",
);
const DatabaseCeiling = regressionTest(
  "database/tests/access-control-plane.effect.test.ts",
  "activates a ceiling shrink only after every stage is verified",
  "#92",
);
const DatabaseKillSwitch = regressionTest(
  "database/tests/provider-budget-enforcement.effect.test.ts",
  "applies and removes one binding-local zero-rate kill switch",
  "#92",
);
const DatabaseBudgetRetry = regressionTest(
  "database/tests/provider-budget-enforcement.effect.test.ts",
  "returns identical deterministic windows for an exact retry",
  "#92",
);
const DatabaseSettlement = regressionTest(
  "database/tests/provider-budget-enforcement.effect.test.ts",
  "makes provider settlement exactly idempotent and rejects conflicting usage",
  "#92",
);
const HttpDependency = regressionTest(
  "packages/agentos/src/access/tests/http-authorizer.effect.test.ts",
  "reports policy-decision dependency failures as unavailable",
  "#92",
);
const HttpBudget = regressionTest(
  "packages/agentos/src/access/tests/http-authorizer.effect.test.ts",
  "returns stable AgentOS envelopes for rate and budget exhaustion",
  "#92",
);
const AuthorizerReadiness = regressionTest(
  "services/egress-authz/tests/app.effect.test.ts",
  "fails readiness closed without exposing the dependency failure",
  "#92",
);
const AuthorizerInternet = regressionTest(
  "services/egress-authz/tests/kubernetes.effect.test.ts",
  "grants only identity review reads and keeps ordinary Internet egress",
  "#92",
);
const Agentgateway = regressionTest(
  "services/agentgateway/tests/conformance.effect.test.ts",
  "preserves AgentOS authorization, credential, provider, stream, MCP, telemetry, and reload semantics",
  "#92",
);
const AgentgatewayTopology = regressionTest(
  "services/agentgateway/tests/contract.effect.test.ts",
  "renders a private, fail-closed, split-credential topology",
  "#92",
);
const GitHubRest = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "forwards an allowed REST call with only an exact scoped installation token",
  "#94",
);
const GitHubDenied = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "never acquires a credential for a missing or route-mismatched grant",
  "#94",
);
const GitHubSmartHttp = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "uses Basic installation auth for smart HTTP and preserves native failures",
  "#94",
);
const GitHubGraphql = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "permits repository-bound GraphQL reads and rejects opaque mutations",
  "#94",
);
const GitHubRefresh = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "invalidates a rejected installation token for the next native call",
  "#94",
);
const GitHubSettlement = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "settles completed and provider-rejected forwards after their bodies terminate",
  "#94",
);
const GitHubTransport = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "settles transport failures while a settlement outage never replaces provider semantics",
  "#94",
);
const GitHubCancellation = regressionTest(
  "services/github-broker/tests/broker.effect.test.ts",
  "settles a downstream-cancelled response as cancelled exactly once",
  "#94",
);
const GitHubTokenCache = regressionTest(
  "services/github-broker/tests/token-cache.effect.test.ts",
  "mints one exact repository token for concurrent requests and refreshes before expiry",
  "#94",
);
const GitHubCredentialHelper = regressionTest(
  "packages/agentos/runtime/tests/github-workload-auth.effect.test.ts",
  "serves Git credential protocol from the current projected token",
  "#94",
);
const GitHubNativeErrors = regressionTest(
  "packages/agentos/runtime/tests/github-workload-auth.effect.test.ts",
  "preserves native stderr and exit status without leaking identity",
  "#94",
);
const GitHubNativeLive = regressionTest(
  "packages/agentos/runtime/tests/github-native-clients.effect.test.ts",
  "runs git, gh, and gh-axi through the real projected-identity boundary",
  "#92",
);
const GitHubProvider = regressionTest(
  "packages/agentos/runtime/tests/github-provider.effect.test.ts",
  "installs owned native wrappers and a narrow Git include",
  "#94",
);
const GitHubGraphqlRoute = regressionTest(
  "packages/agentos/src/access/tests/github-routes.effect.test.ts",
  "classifies a bounded GraphQL query from its exact repository",
  "#94",
);
export const ACCESS_RESILIENCE_REGRESSION_SOURCES: ReadonlyArray<
  AccessResilienceRegressionSourceV1
> = [
  ...regressionPair("identity.impersonation_denied", IdentityImpersonation, PolicyRoute),
  ...regressionPair("identity.wrong_audience", AccessLive, IdentityAudience),
  ...regressionPair("identity.expired_token", IdentityExpiry, KubernetesFailures),
  ...regressionPair("identity.stale_pod_uid", AccessLive, IdentityAudience),
  ...regressionPair("identity.deleted_pod", AccessLive, KubernetesObjects),
  ...regressionPair("identity.stale_serviceaccount_uid", AccessLive, IdentityAudience),
  ...regressionPair("identity.deleted_serviceaccount", AccessLive, KubernetesObjects),
  ...regressionPair("identity.assignment_ended", IdentityInactive, DatabaseAssignment),
  ...regressionPair("identity.exact_custody", IdentityExact, PostgresIdentity),
  ...regressionPair("authorization.profile_allow", PolicyAllow, DatabaseProfile),
  ...regressionPair("authorization.scope_mismatch", PolicyRoute, PolicyDenials),
  ...regressionPair("authorization.profile_rebind", AccessLive, DatabaseProfile),
  ...regressionPair("authorization.binding_revocation", AccessLive, DatabaseBinding),
  ...regressionPair("authorization.ceiling_shrink", ControlCeiling, DatabaseCeiling),
  ...regressionPair("authorization.openfga_consistency", OpenFgaConsistency, OpenFgaReadiness),
  ...regressionPair("authorization.rate_effective_zero", PolicyDenials, DatabaseKillSwitch),
  ...regressionPair("authorization.budget_kill_switch", DatabaseKillSwitch, HttpBudget),
  ...regressionPair("authorization.unrelated_subject_continuity", AccessLive, OpenFgaIsolation),
  ...regressionPair("dependency.tokenreview_outage", IdentityUnavailable, KubernetesFailures),
  ...regressionPair("dependency.postgresql_outage", PostgresFailure, PostgresRecovery),
  ...regressionPair("dependency.openfga_outage", PolicyOpenFgaFailure, AuthorizerReadiness),
  ...regressionPair("dependency.authorizer_outage", HttpDependency, AuthorizerReadiness),
  ...regressionPair("dependency.agentgateway_outage", Agentgateway, AgentgatewayTopology),
  ...regressionPair("dependency.provider_adapter_outage", GitHubTransport, GitHubDenied),
  ...regressionPair("credential.provider_expiry_refresh", GitHubTokenCache, GitHubRefresh),
  ...regressionPair("credential.projected_token_rotation", AccessLive, KubernetesRotation),
  ...regressionPair("transport.bounded_retry", GitHubTokenCache, DatabaseBudgetRetry),
  ...regressionPair("transport.stream_completion", GitHubSettlement, Agentgateway),
  ...regressionPair("transport.cancellation", GitHubCancellation, GitHubSettlement),
  ...regressionPair("transport.failure", GitHubTransport, GitHubNativeErrors),
  ...regressionPair("settlement.exactly_once", DatabaseSettlement, GitHubSettlement),
  ...regressionPair("internet.ordinary_continuity", AccessLive, AuthorizerInternet),
  ...regressionPair("native.github_rest", GitHubRest, GitHubNativeLive),
  ...regressionPair("native.github_graphql", GitHubGraphql, GitHubGraphqlRoute),
  ...regressionPair("native.git_smart_http", GitHubSmartHttp, GitHubNativeLive),
  ...regressionPair("native.git_projected_identity", GitHubNativeLive, GitHubCredentialHelper),
  ...regressionPair("native.gh_projected_identity", GitHubNativeLive, GitHubNativeErrors),
  ...regressionPair("native.gh_axi_projected_identity", GitHubNativeLive, GitHubProvider),
];

const RegressionSourceErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "path_outside_repository",
  "file_unavailable",
  "title_missing",
  "title_ambiguous",
  "non_effect_regression",
  "scenario_reference_missing",
  "scenario_reference_duplicate",
  "original_held_out_reused",
]);

export class AccessResilienceRegressionSourceError extends Schema.TaggedErrorClass<AccessResilienceRegressionSourceError>()(
  "AccessResilienceRegressionSourceError",
  {
    code: RegressionSourceErrorCodeSchema,
    scenario: Schema.NullOr(AccessResilienceScenarioIdSchema),
    kind: Schema.NullOr(RegressionKindSchema),
  },
) {}

const RegressionVerificationOptionsSchema = Schema.Struct({
  repositoryRoot: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  ),
  references: Schema.Array(AccessResilienceRegressionSourceV1Schema).pipe(
    Schema.check(Schema.isMaxLength(ACCESS_RESILIENCE_SCENARIOS.length * 2 + 1)),
  ),
});

export const verifyAccessResilienceRegressionSources = Effect.fn(
  "agentos.access.verifyResilienceRegressionSources",
)(function*(input: unknown) {
  const options = yield* Schema.decodeUnknownEffect(
    RegressionVerificationOptionsSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => regressionError("invalid_contract", null, null)),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const repositoryRoot = paths.resolve(options.repositoryRoot);
  for (const reference of options.references) {
    const resolved = paths.resolve(repositoryRoot, reference.path);
    const relative = paths.relative(repositoryRoot, resolved);
    if (
      relative === ".." || relative.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(relative)
    ) {
      return yield* regressionError(
        "path_outside_repository",
        reference.scenario,
        reference.kind,
      );
    }
    const source = yield* fileSystem.readFileString(resolved).pipe(
      Effect.mapError(() =>
        regressionError("file_unavailable", reference.scenario, reference.kind)
      ),
    );
    const first = source.indexOf(reference.title);
    if (first < 0) {
      return yield* regressionError("title_missing", reference.scenario, reference.kind);
    }
    if (source.indexOf(reference.title, first + reference.title.length) >= 0) {
      return yield* regressionError("title_ambiguous", reference.scenario, reference.kind);
    }
    if (!source.slice(Math.max(0, first - 128), first).includes("it.effect")) {
      return yield* regressionError("non_effect_regression", reference.scenario, reference.kind);
    }
  }
  for (const scenario of ACCESS_RESILIENCE_SCENARIOS) {
    const original = options.references.filter((reference) =>
      reference.scenario === scenario && reference.kind === "original"
    );
    const heldOut = options.references.filter((reference) =>
      reference.scenario === scenario && reference.kind === "held_out"
    );
    if (original.length === 0 || heldOut.length === 0) {
      return yield* regressionError("scenario_reference_missing", scenario, null);
    }
    if (original.length !== 1 || heldOut.length !== 1) {
      return yield* regressionError("scenario_reference_duplicate", scenario, null);
    }
    const first = original[0];
    const second = heldOut[0];
    if (first === undefined || second === undefined) {
      return yield* regressionError("scenario_reference_missing", scenario, null);
    }
    if (first.path === second.path && first.title === second.title) {
      return yield* regressionError("original_held_out_reused", scenario, null);
    }
  }
  return {
    version: 1,
    scenarioCount: ACCESS_RESILIENCE_SCENARIOS.length,
    referenceCount: options.references.length,
    allEffectNative: true,
  };
});

function regressionError(
  code: AccessResilienceRegressionSourceError["code"],
  scenario: AccessResilienceScenarioId | null,
  kind: AccessResilienceRegressionSourceV1["kind"] | null,
) {
  return AccessResilienceRegressionSourceError.make({ code, scenario, kind });
}
