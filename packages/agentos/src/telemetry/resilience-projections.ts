import { Effect, Schema } from "effect";

import type { ProtocolResilienceObservationV1 } from "../protocol/resilience-conformance.ts";
import {
  decodeAssignmentExecutionEpochObservation,
  type AssignmentExecutionEpochObservationV1,
} from "../supervision/retry-recovery.ts";
import type { CompiledSecondMateTopologyPlanV1 } from "../topology/second-mate.ts";
import type { AgentWorkloadPlanSummaryV1 } from "../workloads/compiler.ts";
import {
  RESILIENCE_CAUSES,
  RESILIENCE_RECOVERY_CLASSES,
  RUNTIME_OPERATION_JOURNAL_PHASES,
  ResilienceProtectedCorrelationV1Schema,
  decodeResilienceObservation,
  type ResilienceCause,
  type ResilienceObservationV1,
  type ResilienceProtectedCorrelationV1,
  type ResilienceRecoveryClass,
  type RuntimeOperationJournalPhase,
} from "./resilience-contract.ts";

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);
const OpaqueIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z_.:@/-]+$/),
  ),
);
const AttemptSchema = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(32),
  ),
);
const RuntimeActionSchema = Schema.Literals([
  "provision",
  "rollout",
  "recover",
  "teardown",
]);

const ReadinessComponentSchema = Schema.Literals([
  "agent",
  "assignment",
  "brief",
  "confirmation",
  "coordination",
  "credential",
  "database",
  "harness",
  "herdr",
  "provider",
  "session",
]);

const ReadinessReasonCodeSchema = Schema.Literals([
  "agent_ambiguous",
  "agent_blocked",
  "agent_cwd_mismatch",
  "agent_missing",
  "agent_observation_invalid",
  "assignment_identity_invalid",
  "brief_digest_invalid",
  "brief_digest_mismatch",
  "brief_missing",
  "budget_settlement_unavailable",
  "coordination_catchup_incomplete",
  "coordination_listener_missing",
  "crewmate_confirmation_invalid",
  "crewmate_confirmation_missing",
  "database_credential_unavailable",
  "database_identity_invalid",
  "database_identity_mismatch",
  "database_identity_unconfigured",
  "harness_mismatch",
  "harness_observation_invalid",
  "herdr_unavailable",
  "pane_process_unavailable",
  "provider_configuration_invalid",
  "provider_credential_unavailable",
  "provider_credential_unknown",
  "runtime_configuration_invalid",
  "session_cwd_mismatch",
  "session_invalid",
  "session_missing",
]);

export const RuntimeJournalTelemetryInputV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  action: RuntimeActionSchema,
  phase: Schema.Literals(RUNTIME_OPERATION_JOURNAL_PHASES),
  attempt: AttemptSchema,
  cause: Schema.Literals(RESILIENCE_CAUSES),
  recovery: Schema.Literals(RESILIENCE_RECOVERY_CLASSES),
  agentId: UuidSchema,
  assignmentId: Schema.NullOr(UuidSchema),
  operationId: UuidSchema,
  renderedManifestDigest: DigestSchema,
  podUid: Schema.NullOr(UuidSchema),
  pvcUid: Schema.NullOr(UuidSchema),
  sessionId: Schema.NullOr(OpaqueIdSchema),
});

export const NativeSessionTelemetryInputV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals([
    "available",
    "resumed",
    "unavailable",
    "unobserved",
  ]),
  attempt: AttemptSchema,
  agentId: UuidSchema,
  assignmentId: Schema.NullOr(UuidSchema),
  operationId: UuidSchema,
  sessionId: Schema.NullOr(OpaqueIdSchema),
});

export const SemanticReadinessDiagnosticProjectionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  role: Schema.Literals([
    "crewmate",
    "first_mate",
    "second_mate",
    "unknown",
  ]),
  mode: Schema.Literals(["live", "ready"]),
  status: Schema.Literals([
    "degraded",
    "live",
    "not_live",
    "not_ready",
    "ready",
  ]),
  checks: Schema.Array(Schema.Struct({
    component: ReadinessComponentSchema,
    status: Schema.Literals(["degraded", "fail", "pass"]),
  })),
  reasons: Schema.Array(Schema.Struct({
    component: ReadinessComponentSchema,
    code: ReadinessReasonCodeSchema,
  })),
});

export const SemanticReadinessTelemetryInputV1Schema = Schema.Struct({
  diagnostic: SemanticReadinessDiagnosticProjectionV1Schema,
  attempt: AttemptSchema,
  protected: ResilienceProtectedCorrelationV1Schema,
});

export type RuntimeJournalTelemetryInputV1 =
  typeof RuntimeJournalTelemetryInputV1Schema.Type;
export type NativeSessionTelemetryInputV1 =
  typeof NativeSessionTelemetryInputV1Schema.Type;
export type SemanticReadinessDiagnosticProjectionV1 =
  typeof SemanticReadinessDiagnosticProjectionV1Schema.Type;
export type SemanticReadinessTelemetryInputV1 =
  typeof SemanticReadinessTelemetryInputV1Schema.Type;

const ResilienceProjectionErrorCodeSchema = Schema.Literals([
  "invalid_input",
  "missing_protected_correlation",
]);

export class ResilienceProjectionError extends Schema.TaggedErrorClass<ResilienceProjectionError>()(
  "ResilienceProjectionError",
  {
    code: ResilienceProjectionErrorCodeSchema,
    field: Schema.String,
  },
) {}

export const projectSecondMateTopologyPlan = Effect.fn(
  "agentos.resilienceTelemetry.projectTopologyPlan",
)(function*(
  plan: CompiledSecondMateTopologyPlanV1,
  correlation: {
    readonly assignmentId: string | null;
    readonly operationId: string;
  },
) {
  return yield* Effect.forEach(plan.proposal.reasons, (topologyReason) =>
    decodeResilienceObservation({
      ...baseObservation(protectedCorrelation({
        agentId: plan.proposal.proposedByAgentId,
        assignmentId: correlation.assignmentId,
        operationId: correlation.operationId,
        proposalId: plan.proposal.proposalId,
      })),
      source: "topology_plan",
      phase: "topology_decision",
      outcome: "pending",
      recovery: "not_required",
      topologyAction: plan.proposal.action,
      topologyReason,
    }),
  );
});

type WorkloadSummaryProjection = Pick<
  AgentWorkloadPlanSummaryV1,
  | "agentId"
  | "assignmentId"
  | "profileId"
  | "specVersion"
  | "specDigest"
  | "overlayDigest"
>;

export const projectAgentWorkloadPlan = Effect.fn(
  "agentos.resilienceTelemetry.projectWorkloadPlan",
)(function*(input: {
  readonly action: typeof RuntimeActionSchema.Type;
  readonly operationId: string;
  readonly summary: WorkloadSummaryProjection;
}) {
  return yield* decodeResilienceObservation({
    ...baseObservation(protectedCorrelation({
      agentId: input.summary.agentId,
      assignmentId: input.summary.assignmentId,
      operationId: input.operationId,
    })),
    source: "workload_plan",
    phase: "workload_plan",
    outcome: "pending",
    recovery: "not_required",
    runtimeAction: input.action,
    workloadProfile: input.summary.profileId,
    workloadSpecVersion: input.summary.specVersion,
    workloadSpecDigest: input.summary.specDigest,
    workloadOverlayDigest: input.summary.overlayDigest,
  });
});

export const projectRuntimeJournalObservation = Effect.fn(
  "agentos.resilienceTelemetry.projectRuntimeJournal",
)(function*(input: unknown) {
  const decoded = yield* decodeStrict(
    RuntimeJournalTelemetryInputV1Schema,
    input,
  );
  yield* validateJournalState(decoded);
  const mapped = journalOutcome(decoded.phase, decoded.cause, decoded.recovery);
  return yield* decodeResilienceObservation({
    ...baseObservation(protectedCorrelation({
      agentId: decoded.agentId,
      assignmentId: decoded.assignmentId,
      operationId: decoded.operationId,
      podUid: decoded.podUid,
      pvcUid: decoded.pvcUid,
      sessionId: decoded.sessionId,
    })),
    source: "runtime_journal",
    phase: mapped.phase,
    outcome: mapped.outcome,
    cause: mapped.cause,
    recovery: mapped.recovery,
    attempt: decoded.attempt,
    runtimeAction: decoded.action,
    renderedManifestDigest: decoded.renderedManifestDigest,
    journalPhase: decoded.phase,
  });
});

export const projectSemanticReadinessDiagnostic = Effect.fn(
  "agentos.resilienceTelemetry.projectSemanticReadiness",
)(function*(input: unknown) {
  const decoded = yield* decodeStrict(
    SemanticReadinessTelemetryInputV1Schema,
    input,
    "$.diagnostic",
  );
  const success = decoded.diagnostic.status === "ready" ||
    decoded.diagnostic.status === "live";
  return yield* decodeResilienceObservation({
    ...baseObservation(decoded.protected),
    source: "semantic_readiness",
    phase: "readiness",
    outcome: success
      ? "succeeded"
      : decoded.diagnostic.status === "degraded"
        ? "degraded"
        : "failed",
    cause: success ? "none" : readinessCause(decoded.diagnostic),
    recovery: success ? "not_required" : "retry",
    attempt: decoded.attempt,
  });
});

export const projectNativeSessionObservation = Effect.fn(
  "agentos.resilienceTelemetry.projectNativeSession",
)(function*(input: unknown) {
  const decoded = yield* decodeStrict(
    NativeSessionTelemetryInputV1Schema,
    input,
  );
  const unobserved = decoded.state === "unobserved";
  return yield* decodeResilienceObservation({
    ...baseObservation(protectedCorrelation({
      agentId: decoded.agentId,
      assignmentId: decoded.assignmentId,
      operationId: decoded.operationId,
      sessionId: decoded.sessionId,
    })),
    source: "native_session",
    phase: "session",
    evidence: unobserved ? "unobserved" : "observed",
    outcome: unobserved
      ? "unobserved"
      : decoded.state === "available"
        ? "succeeded"
        : decoded.state === "resumed"
          ? "recovered"
          : "degraded",
    cause: decoded.state === "available" || unobserved
      ? "none"
      : "native_session",
    recovery: unobserved
      ? "unobserved"
      : decoded.state === "available"
        ? "not_required"
        : decoded.state === "resumed"
          ? "native_session_resume"
          : "retry",
    attempt: decoded.attempt,
  });
});

export const projectAssignmentExecutionObservation = Effect.fn(
  "agentos.resilienceTelemetry.projectAssignmentExecution",
)(function*(input: unknown) {
  const decoded = yield* decodeAssignmentExecutionEpochObservation(input);
  const mapped = assignmentExecutionOutcome(decoded);
  return yield* decodeResilienceObservation({
    ...baseObservation(protectedCorrelation({
      agentId: decoded.agentId,
      assignmentId: decoded.assignmentId,
      operationId: decoded.operationId,
      sessionId: decoded.nativeSessionRef,
    })),
    source: "assignment",
    phase: "outcome",
    outcome: mapped.outcome,
    cause: mapped.cause,
    failureClass: decoded.failureClass,
    recovery: mapped.recovery,
    attempt: decoded.attemptsObserved ?? 0,
  });
});

export const projectProtocolResilienceObservation = Effect.fn(
  "agentos.resilienceTelemetry.projectProtocol",
)(function*(
  observation: ProtocolResilienceObservationV1,
  correlation: { readonly operationId: string },
) {
  if (!observation.trace.protected || observation.trace.agentId === null) {
    return yield* projectionError(
      "missing_protected_correlation",
      "$.trace.agentId",
    );
  }
  return yield* decodeResilienceObservation({
    ...baseObservation(protectedCorrelation({
      agentId: observation.trace.agentId,
      assignmentId: observation.trace.assignmentId,
      operationId: correlation.operationId,
      protocolId: observation.trace.protocolId,
    })),
    source: observation.protocol,
    phase: "protocol",
    outcome: protocolOutcome(observation.observed),
    cause: protocolCause(observation.failureClass),
    recovery: observation.recovery,
    protocol: observation.protocol,
  });
});

function baseObservation(
  protectedCorrelation: ResilienceProtectedCorrelationV1,
) {
  return {
    version: 1,
    source: "assignment",
    phase: "outcome",
    evidence: "observed",
    outcome: "pending",
    cause: "none",
    failureClass: null,
    recovery: "not_required",
    attempt: 0,
    topologyAction: null,
    topologyReason: null,
    runtimeAction: null,
    workloadProfile: null,
    workloadSpecVersion: null,
    workloadSpecDigest: null,
    workloadOverlayDigest: null,
    renderedManifestDigest: null,
    journalPhase: null,
    protocol: null,
    protected: protectedCorrelation,
  } satisfies ResilienceObservationV1;
}

function assignmentExecutionOutcome(
  observation: AssignmentExecutionEpochObservationV1,
): Pick<ResilienceObservationV1, "outcome" | "cause" | "recovery"> {
  switch (observation.state) {
    case "active":
      return {
        outcome: "pending",
        cause: "none",
        recovery: "not_required",
      };
    case "completed":
      return {
        outcome: "succeeded",
        cause: "none",
        recovery: "not_required",
      };
    case "exhausted":
      return {
        outcome: "blocked",
        cause: "retry_exhausted",
        recovery: "awaiting_supervisor",
      };
    case "resumed":
      return {
        outcome: "recovered",
        cause: "retry_exhausted",
        recovery: "native_session_resume",
      };
    case "reassigned":
      return {
        outcome: "recovered",
        cause: "retry_exhausted",
        recovery: "reassigned",
      };
    case "stopped":
      return {
        outcome: "blocked",
        cause: "retry_exhausted",
        recovery: "stopped",
      };
  }
}

function protectedCorrelation(input: {
  readonly agentId: string;
  readonly assignmentId: string | null;
  readonly operationId: string;
  readonly proposalId?: string | null;
  readonly podUid?: string | null;
  readonly pvcUid?: string | null;
  readonly sessionId?: string | null;
  readonly protocolId?: string | null;
}): ResilienceProtectedCorrelationV1 {
  return {
    agentId: input.agentId,
    assignmentId: input.assignmentId,
    operationId: input.operationId,
    proposalId: input.proposalId ?? null,
    podUid: input.podUid ?? null,
    pvcUid: input.pvcUid ?? null,
    sessionId: input.sessionId ?? null,
    protocolId: input.protocolId ?? null,
  };
}

function journalOutcome(
  phase: RuntimeOperationJournalPhase,
  cause: ResilienceCause,
  recovery: ResilienceRecoveryClass,
): Pick<ResilienceObservationV1, "phase" | "outcome" | "cause" | "recovery"> {
  switch (phase) {
    case "prepared":
      return stableJournal("reconciliation");
    case "applied":
      return stableJournal("apply");
    case "workload_ready":
    case "harness_ready":
      return {
        phase: "readiness",
        outcome: "succeeded",
        cause: "none",
        recovery: "not_required",
      };
    case "recovery_required":
      return {
        phase: "reconciliation",
        outcome: "degraded",
        cause,
        recovery,
      };
    case "completed":
      return {
        phase: "outcome",
        outcome: "succeeded",
        cause: "none",
        recovery: "not_required",
      };
    case "failed":
      return { phase: "outcome", outcome: "failed", cause, recovery };
    case "superseded":
      return {
        phase: "reconciliation",
        outcome: "recovered",
        cause,
        recovery: "superseded",
      };
  }
}

function stableJournal(
  phase: ResilienceObservationV1["phase"],
): Pick<ResilienceObservationV1, "phase" | "outcome" | "cause" | "recovery"> {
  return {
    phase,
    outcome: "pending",
    cause: "none",
    recovery: "not_required",
  };
}

const validateJournalState = Effect.fn(
  "agentos.resilienceTelemetry.validateJournalState",
)(function*(input: RuntimeJournalTelemetryInputV1) {
  switch (input.phase) {
    case "prepared":
    case "applied":
    case "workload_ready":
    case "harness_ready":
    case "completed":
      if (input.cause !== "none" || input.recovery !== "not_required") {
        return yield* projectionError("invalid_input", "$.phase");
      }
      return;
    case "recovery_required":
    case "failed":
      if (
        input.cause === "none" ||
        input.recovery === "not_required" ||
        input.recovery === "unobserved" ||
        input.recovery === "superseded"
      ) {
        return yield* projectionError("invalid_input", "$.phase");
      }
      return;
    case "superseded":
      if (input.cause === "none" || input.recovery !== "superseded") {
        return yield* projectionError("invalid_input", "$.phase");
      }
      return;
  }
});

function readinessCause(
  diagnostic: SemanticReadinessDiagnosticProjectionV1,
): ResilienceCause {
  if (diagnostic.reasons.some(({ component }) =>
    component === "provider" || component === "credential"
  )) return "provider";
  if (diagnostic.reasons.some(({ component }) => component === "coordination")) {
    return "listener";
  }
  if (diagnostic.reasons.some(({ component }) =>
    component === "harness" ||
    component === "herdr" ||
    component === "session"
  )) return "native_session";
  if (diagnostic.reasons.some(({ component }) => component === "assignment")) {
    return "policy";
  }
  return "readiness";
}

function protocolOutcome(
  observed: ProtocolResilienceObservationV1["observed"],
): ResilienceObservationV1["outcome"] {
  switch (observed) {
    case "succeeded":
      return "succeeded";
    case "denied":
    case "unsupported_rejected":
      return "blocked";
    case "dependency_unavailable":
      return "degraded";
    case "fallback_recovered":
      return "recovered";
  }
}

function protocolCause(
  failure: ProtocolResilienceObservationV1["failureClass"],
): ResilienceCause {
  switch (failure) {
    case "none":
      return "none";
    case "replacement":
      return "native_session";
    case "authorizer_unavailable":
    case "identity_denied":
    case "hierarchy_denied":
    case "assignment_denied":
    case "profile_revoked":
    case "skill_denied":
    case "privacy_rejected":
    case "dual_writer":
    case "unsupported_method":
      return "policy";
    case "postgresql_unavailable":
      return "listener";
    case "adapter_loss":
    case "timeout":
    case "gateway_unavailable":
    case "target_unavailable":
      return "protocol_adapter";
  }
}

function decodeStrict<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  field = "$",
) {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.mapError(() => projectionError("invalid_input", field)),
  );
}

function projectionError(
  code: ResilienceProjectionError["code"],
  field: string,
) {
  return new ResilienceProjectionError({ code, field });
}
