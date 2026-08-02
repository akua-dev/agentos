import { Effect, Schema } from "effect";

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

export const ACP_PROTOCOL_RESILIENCE_SCENARIOS = values(
  "acp.pi.session_create",
  "acp.pi.session_load",
  "acp.pi.prompt",
  "acp.pi.tool_plan_events",
  "acp.pi.permission",
  "acp.pi.cancel",
  "acp.pi.adapter_loss",
  "acp.pi.pod_process_replacement",
  "acp.pi.resume",
  "acp.pi.dual_writer_rejected",
  "acp.codex.session_create",
  "acp.codex.session_load",
  "acp.codex.prompt",
  "acp.codex.tool_plan_events",
  "acp.codex.permission",
  "acp.codex.cancel",
  "acp.codex.adapter_loss",
  "acp.codex.pod_process_replacement",
  "acp.codex.resume",
  "acp.codex.dual_writer_rejected",
);

export const A2A_PROTOCOL_RESILIENCE_SCENARIOS = values(
  "a2a.agent_card",
  "a2a.invoke",
  "a2a.streaming_rejected",
  "a2a.cancel_rejected",
  "a2a.artifact_rejected",
  "a2a.replay",
  "a2a.timeout",
  "a2a.gateway_loss",
  "a2a.authorizer_openfga_loss",
  "a2a.target_loss",
  "a2a.postgresql_loss",
  "a2a.recovery_listener_herdr",
  "a2a.allowed_parent_child",
  "a2a.denied_sibling",
  "a2a.denied_lateral_crewmate",
  "a2a.denied_cross_domain",
  "a2a.denied_inactive_assignment",
  "a2a.denied_revoked_profile",
  "a2a.denied_expired_identity",
  "a2a.denied_guessed_skill",
  "a2a.privacy_rejection",
  "a2a.telemetry_cardinality",
);

export const PROTOCOL_RESILIENCE_SCENARIOS = values(
  ...ACP_PROTOCOL_RESILIENCE_SCENARIOS,
  ...A2A_PROTOCOL_RESILIENCE_SCENARIOS,
);

export const DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS = values(
  "acp.pi.pod_process_replacement",
  "acp.codex.pod_process_replacement",
  "a2a.allowed_parent_child",
  "a2a.denied_sibling",
  "a2a.denied_cross_domain",
  "a2a.denied_expired_identity",
  "a2a.recovery_listener_herdr",
);

export const ProtocolResilienceScenarioIdSchema = Schema.Literals(
  PROTOCOL_RESILIENCE_SCENARIOS,
);
const ProtocolSchema = Schema.Literals(["acp", "a2a"]);
const OutcomeSchema = Schema.Literals([
  "succeeded",
  "denied",
  "dependency_unavailable",
  "fallback_recovered",
  "unsupported_rejected",
]);
const FailureClassSchema = Schema.Literals([
  "none",
  "adapter_loss",
  "replacement",
  "dual_writer",
  "unsupported_method",
  "timeout",
  "gateway_unavailable",
  "authorizer_unavailable",
  "target_unavailable",
  "postgresql_unavailable",
  "identity_denied",
  "hierarchy_denied",
  "assignment_denied",
  "profile_revoked",
  "skill_denied",
  "privacy_rejected",
]);
const RecoverySchema = Schema.Literals([
  "not_required",
  "native_session_resume",
  "postgresql_listener_then_herdr_wake",
]);
const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const OpaqueIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z_.:-]+$/),
  ),
);
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
);
const RevisionSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
);
const MetricDimensionSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9_]*$/),
  ),
);

export const ProtocolResilienceObservationV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  scenario: ProtocolResilienceScenarioIdSchema,
  protocol: ProtocolSchema,
  source: Schema.Literals(["effect_fixture", "disposable_kubernetes"]),
  observed: OutcomeSchema,
  failureClass: FailureClassSchema,
  recovery: RecoverySchema,
  elapsedMillis: NonNegativeIntegerSchema,
  revocationMillis: Schema.NullOr(NonNegativeIntegerSchema),
  durableMutations: Schema.Struct({
    tasks: NonNegativeIntegerSchema,
    assignments: NonNegativeIntegerSchema,
    inbox: NonNegativeIntegerSchema,
    executions: NonNegativeIntegerSchema,
    reports: NonNegativeIntegerSchema,
  }),
  custody: Schema.Struct({
    sessionAuthority: Schema.Literals([
      "provider_native",
      "not_applicable",
    ]),
    nativeSessionAvailable: Schema.NullOr(Schema.Boolean),
    maximumActiveWriters: NonNegativeIntegerSchema,
    herdrAttachable: Schema.Boolean,
    canonicalWorkAuthority: Schema.Literal("postgresql"),
  }),
  trace: Schema.Struct({
    protected: Schema.Boolean,
    agentId: Schema.NullOr(UuidSchema),
    assignmentId: Schema.NullOr(UuidSchema),
    workloadId: Schema.NullOr(OpaqueIdSchema),
    gatewayId: Schema.NullOr(OpaqueIdSchema),
    protocolId: Schema.NullOr(OpaqueIdSchema),
    adapterId: Schema.NullOr(OpaqueIdSchema),
    recoveryId: Schema.NullOr(OpaqueIdSchema),
  }),
  metricDimensions: Schema.Array(MetricDimensionSchema).pipe(
    Schema.check(Schema.isMaxLength(16)),
  ),
  observedContent: Schema.Array(Schema.Literals([
    "prompt",
    "brief",
    "inbox_body",
    "transcript",
    "plan",
    "tool_payload",
    "artifact",
    "credential",
    "provider_identity",
    "private_memory",
  ])).pipe(Schema.check(Schema.isMaxLength(10))),
});

export const ProtocolResilienceRunV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  revision: RevisionSchema,
  environment: Schema.Struct({
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
  }),
  images: Schema.Array(Schema.Struct({
    name: Schema.Literals([
      "agentos",
      "agentgateway",
      "openfga",
      "postgresql",
      "kubernetes-node",
    ]),
    digest: DigestSchema,
  })).pipe(Schema.check(Schema.isMaxLength(5))),
  observations: Schema.Array(ProtocolResilienceObservationV1Schema).pipe(
    Schema.check(Schema.isMaxLength(PROTOCOL_RESILIENCE_SCENARIOS.length + 1)),
  ),
});

export type ProtocolResilienceScenarioId =
  typeof ProtocolResilienceScenarioIdSchema.Type;
export type ProtocolResilienceObservationV1 =
  typeof ProtocolResilienceObservationV1Schema.Type;
export type ProtocolResilienceRunV1 = typeof ProtocolResilienceRunV1Schema.Type;

export interface ProtocolResilienceScenarioDefinition {
  readonly expected: typeof OutcomeSchema.Type;
  readonly failureClass: typeof FailureClassSchema.Type;
  readonly recovery: typeof RecoverySchema.Type;
}

const GateErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "production_boundary_contacted",
  "disposable_cleanup_missing",
  "image_pin_missing",
  "scenario_missing",
  "scenario_duplicate",
  "outcome_mismatch",
  "disposable_observation_missing",
  "custody_violation",
  "revocation_slo_exceeded",
  "content_leak",
  "metric_cardinality_violation",
  "trace_not_protected",
  "trace_continuity_missing",
]);

export class ProtocolResilienceGateError extends Schema.TaggedErrorClass<ProtocolResilienceGateError>()(
  "ProtocolResilienceGateError",
  {
    code: GateErrorCodeSchema,
    scenario: Schema.NullOr(ProtocolResilienceScenarioIdSchema),
  },
) {}

export function protocolResilienceScenarioDefinition(
  scenario: ProtocolResilienceScenarioId,
): ProtocolResilienceScenarioDefinition {
  switch (scenario) {
    case "acp.pi.adapter_loss":
    case "acp.codex.adapter_loss":
      return {
        expected: "fallback_recovered",
        failureClass: "adapter_loss",
        recovery: "native_session_resume",
      };
    case "acp.pi.pod_process_replacement":
    case "acp.codex.pod_process_replacement":
      return {
        expected: "fallback_recovered",
        failureClass: "replacement",
        recovery: "native_session_resume",
      };
    case "acp.pi.dual_writer_rejected":
    case "acp.codex.dual_writer_rejected":
      return {
        expected: "denied",
        failureClass: "dual_writer",
        recovery: "not_required",
      };
    case "a2a.streaming_rejected":
    case "a2a.cancel_rejected":
    case "a2a.artifact_rejected":
      return {
        expected: "unsupported_rejected",
        failureClass: "unsupported_method",
        recovery: "not_required",
      };
    case "a2a.timeout":
      return {
        expected: "dependency_unavailable",
        failureClass: "timeout",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.gateway_loss":
      return {
        expected: "dependency_unavailable",
        failureClass: "gateway_unavailable",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.authorizer_openfga_loss":
      return {
        expected: "dependency_unavailable",
        failureClass: "authorizer_unavailable",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.target_loss":
      return {
        expected: "dependency_unavailable",
        failureClass: "target_unavailable",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.postgresql_loss":
      return {
        expected: "dependency_unavailable",
        failureClass: "postgresql_unavailable",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.recovery_listener_herdr":
      return {
        expected: "fallback_recovered",
        failureClass: "target_unavailable",
        recovery: "postgresql_listener_then_herdr_wake",
      };
    case "a2a.denied_expired_identity":
      return {
        expected: "denied",
        failureClass: "identity_denied",
        recovery: "not_required",
      };
    case "a2a.denied_sibling":
    case "a2a.denied_lateral_crewmate":
    case "a2a.denied_cross_domain":
      return {
        expected: "denied",
        failureClass: "hierarchy_denied",
        recovery: "not_required",
      };
    case "a2a.denied_inactive_assignment":
      return {
        expected: "denied",
        failureClass: "assignment_denied",
        recovery: "not_required",
      };
    case "a2a.denied_revoked_profile":
      return {
        expected: "denied",
        failureClass: "profile_revoked",
        recovery: "not_required",
      };
    case "a2a.denied_guessed_skill":
      return {
        expected: "denied",
        failureClass: "skill_denied",
        recovery: "not_required",
      };
    case "a2a.privacy_rejection":
      return {
        expected: "denied",
        failureClass: "privacy_rejected",
        recovery: "not_required",
      };
    case "acp.pi.session_create":
    case "acp.pi.session_load":
    case "acp.pi.prompt":
    case "acp.pi.tool_plan_events":
    case "acp.pi.permission":
    case "acp.pi.cancel":
    case "acp.pi.resume":
    case "acp.codex.session_create":
    case "acp.codex.session_load":
    case "acp.codex.prompt":
    case "acp.codex.tool_plan_events":
    case "acp.codex.permission":
    case "acp.codex.cancel":
    case "acp.codex.resume":
    case "a2a.agent_card":
    case "a2a.invoke":
    case "a2a.replay":
    case "a2a.allowed_parent_child":
    case "a2a.telemetry_cardinality":
      return {
        expected: "succeeded",
        failureClass: "none",
        recovery: "not_required",
      };
  }
}

const RequiredImageNames = values(
  "agentos",
  "agentgateway",
  "openfga",
  "postgresql",
  "kubernetes-node",
);
const AllowedMetricDimensions = values(
  "protocol",
  "operation",
  "outcome",
  "failure_class",
  "recovery",
);
const RevocationScenarios = values(
  "a2a.denied_inactive_assignment",
  "a2a.denied_revoked_profile",
  "a2a.denied_expired_identity",
);
const RevocationSloMillis = 60_000;

export const compileProtocolResilienceVerdict = Effect.fn(
  "agentos.protocol.compileResilienceVerdict",
)(function*(input: unknown) {
  const run = yield* Schema.decodeUnknownEffect(ProtocolResilienceRunV1Schema, {
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
  for (const name of RequiredImageNames) {
    if (run.images.filter((image) => image.name === name).length !== 1) {
      return yield* gateError("image_pin_missing", null);
    }
  }
  for (const scenario of PROTOCOL_RESILIENCE_SCENARIOS) {
    const matches = run.observations.filter((item) => item.scenario === scenario);
    if (matches.length === 0) {
      return yield* gateError("scenario_missing", scenario);
    }
    if (matches.length !== 1) {
      return yield* gateError("scenario_duplicate", scenario);
    }
    const observation = matches[0];
    if (observation === undefined) {
      return yield* gateError("scenario_missing", scenario);
    }
    const definition = protocolResilienceScenarioDefinition(scenario);
    if (
      observation.observed !== definition.expected ||
      observation.failureClass !== definition.failureClass ||
      observation.recovery !== definition.recovery ||
      observation.protocol !== (scenario.startsWith("acp.") ? "acp" : "a2a")
    ) {
      return yield* gateError("outcome_mismatch", scenario);
    }
    if (
      isDisposableProtocolScenario(scenario) &&
      observation.source !== "disposable_kubernetes"
    ) {
      return yield* gateError("disposable_observation_missing", scenario);
    }
    if (hasDurableMutation(observation)) {
      return yield* gateError("custody_violation", scenario);
    }
    if (observation.protocol === "acp" && (
      observation.custody.sessionAuthority !== "provider_native" ||
      observation.custody.nativeSessionAvailable !== true ||
      observation.custody.maximumActiveWriters > 1 ||
      !observation.custody.herdrAttachable
    )) {
      return yield* gateError("custody_violation", scenario);
    }
    if (
      isRevocationScenario(scenario) &&
      (observation.revocationMillis === null ||
        observation.revocationMillis > RevocationSloMillis)
    ) {
      return yield* gateError("revocation_slo_exceeded", scenario);
    }
    if (observation.observedContent.length !== 0) {
      return yield* gateError("content_leak", scenario);
    }
    if (
      observation.metricDimensions.some((dimension) =>
        !AllowedMetricDimensions.some((allowed) => allowed === dimension)
      ) ||
      new Set(observation.metricDimensions).size !==
        observation.metricDimensions.length
    ) {
      return yield* gateError("metric_cardinality_violation", scenario);
    }
    if (!observation.trace.protected) {
      return yield* gateError("trace_not_protected", scenario);
    }
  }
  if (!hasTraceContinuity(run.observations)) {
    return yield* gateError("trace_continuity_missing", null);
  }
  const disposableKubernetesCount = run.observations.filter((item) =>
    item.source === "disposable_kubernetes"
  ).length;
  return {
    version: 1,
    eligible: true,
    scenarioCount: run.observations.length,
    effectFixtureCount: run.observations.length - disposableKubernetesCount,
    disposableKubernetesCount,
    revocationSloMillis: RevocationSloMillis,
    workAuthority: "postgresql",
    sessionAuthority: "provider_native",
  };
});

function hasDurableMutation(observation: ProtocolResilienceObservationV1) {
  return observation.durableMutations.tasks !== 0 ||
    observation.durableMutations.assignments !== 0 ||
    observation.durableMutations.inbox !== 0 ||
    observation.durableMutations.executions !== 0 ||
    observation.durableMutations.reports !== 0 ||
    observation.custody.canonicalWorkAuthority !== "postgresql";
}

function isDisposableProtocolScenario(
  scenario: ProtocolResilienceScenarioId,
) {
  return DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS.some((candidate) =>
    candidate === scenario
  );
}

function isRevocationScenario(scenario: ProtocolResilienceScenarioId) {
  return RevocationScenarios.some((candidate) => candidate === scenario);
}

function hasTraceContinuity(
  observations: ReadonlyArray<ProtocolResilienceObservationV1>,
) {
  return observations.every((observation) =>
    observation.trace.agentId !== null &&
    observation.trace.assignmentId !== null &&
    observation.trace.workloadId !== null &&
    observation.trace.protocolId !== null &&
    observation.trace.adapterId !== null &&
    (observation.protocol !== "a2a" || observation.trace.gatewayId !== null) &&
    (observation.recovery === "not_required" ||
      observation.trace.recoveryId !== null)
  );
}

function gateError(
  code: ProtocolResilienceGateError["code"],
  scenario: ProtocolResilienceScenarioId | null,
) {
  return ProtocolResilienceGateError.make({ code, scenario });
}
