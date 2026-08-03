import { Effect, Schema } from "effect";

import {
  SecondMateTopologyActionV1Schema,
  SecondMateTopologyReasonV1Schema,
} from "../topology/second-mate.ts";
import { ASSIGNMENT_EXECUTION_FAILURE_CLASSES } from "../supervision/retry-recovery.ts";
import { AgentWorkloadProfileIdSchema } from "../workloads/profiles.ts";
import type { AgentOSTelemetryAttributes } from "./privacy.ts";

export const AGENTOS_RESILIENCE_TELEMETRY_CONTRACT_VERSION = 1;

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

export const RESILIENCE_SOURCES = values(
  "topology_plan",
  "workload_plan",
  "runtime_journal",
  "kubernetes",
  "semantic_readiness",
  "provider",
  "postgresql_listener",
  "native_session",
  "acp",
  "a2a",
  "assignment",
);

export const RESILIENCE_PHASES = values(
  "topology_decision",
  "workload_plan",
  "render",
  "apply",
  "capacity",
  "placement",
  "readiness",
  "provider",
  "listener",
  "protocol",
  "session",
  "reconciliation",
  "outcome",
);

export const RESILIENCE_CAUSES = values(
  "none",
  "invalid_workload_plan",
  "conflicting_workload_plan",
  "render_boundary",
  "apply_boundary",
  "capacity",
  "placement",
  "readiness",
  "provider",
  "listener",
  "protocol_adapter",
  "native_session",
  "policy",
  "reconciliation",
  "retry_exhausted",
);

export const RESILIENCE_FAILURE_CLASSES =
  ASSIGNMENT_EXECUTION_FAILURE_CLASSES;

export const RESILIENCE_OUTCOMES = values(
  "pending",
  "succeeded",
  "degraded",
  "recovered",
  "failed",
  "blocked",
  "unobserved",
);

export const RESILIENCE_RECOVERY_CLASSES = values(
  "not_required",
  "retry",
  "awaiting_supervisor",
  "repair_forward",
  "native_session_resume",
  "postgresql_listener_then_herdr_wake",
  "reassigned",
  "stopped",
  "superseded",
  "unobserved",
);

export const RUNTIME_OPERATION_JOURNAL_PHASES = values(
  "prepared",
  "applied",
  "workload_ready",
  "harness_ready",
  "recovery_required",
  "completed",
  "failed",
  "superseded",
);

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
const BoundedAttemptSchema = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(32),
  ),
);
const VersionSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
);

export const ResilienceProtectedCorrelationV1Schema = Schema.Struct({
  agentId: UuidSchema,
  assignmentId: Schema.NullOr(UuidSchema),
  operationId: UuidSchema,
  proposalId: Schema.NullOr(UuidSchema),
  podUid: Schema.NullOr(UuidSchema),
  pvcUid: Schema.NullOr(UuidSchema),
  sessionId: Schema.NullOr(OpaqueIdSchema),
  protocolId: Schema.NullOr(OpaqueIdSchema),
});

export const ResilienceObservationV1Schema = Schema.Struct({
  version: Schema.Literal(AGENTOS_RESILIENCE_TELEMETRY_CONTRACT_VERSION),
  source: Schema.Literals(RESILIENCE_SOURCES),
  phase: Schema.Literals(RESILIENCE_PHASES),
  evidence: Schema.Literals(["observed", "unobserved"]),
  outcome: Schema.Literals(RESILIENCE_OUTCOMES),
  cause: Schema.Literals(RESILIENCE_CAUSES),
  failureClass: Schema.NullOr(Schema.Literals(RESILIENCE_FAILURE_CLASSES)),
  recovery: Schema.Literals(RESILIENCE_RECOVERY_CLASSES),
  attempt: BoundedAttemptSchema,
  topologyAction: Schema.NullOr(SecondMateTopologyActionV1Schema),
  topologyReason: Schema.NullOr(SecondMateTopologyReasonV1Schema),
  runtimeAction: Schema.NullOr(Schema.Literals([
    "provision",
    "rollout",
    "recover",
    "teardown",
  ])),
  workloadProfile: Schema.NullOr(AgentWorkloadProfileIdSchema),
  workloadSpecVersion: Schema.NullOr(VersionSchema),
  workloadSpecDigest: Schema.NullOr(DigestSchema),
  workloadOverlayDigest: Schema.NullOr(DigestSchema),
  renderedManifestDigest: Schema.NullOr(DigestSchema),
  journalPhase: Schema.NullOr(Schema.Literals(RUNTIME_OPERATION_JOURNAL_PHASES)),
  protocol: Schema.NullOr(Schema.Literals(["acp", "a2a"])),
  protected: ResilienceProtectedCorrelationV1Schema,
});

export type ResilienceObservationV1 =
  typeof ResilienceObservationV1Schema.Type;
export type ResilienceProtectedCorrelationV1 =
  typeof ResilienceProtectedCorrelationV1Schema.Type;
export type ResilienceSource = ResilienceObservationV1["source"];
export type ResiliencePhase = ResilienceObservationV1["phase"];
export type ResilienceCause = ResilienceObservationV1["cause"];
export type ResilienceFailureClass =
  NonNullable<ResilienceObservationV1["failureClass"]>;
export type ResilienceOutcome = ResilienceObservationV1["outcome"];
export type ResilienceRecoveryClass = ResilienceObservationV1["recovery"];
export type RuntimeOperationJournalPhase =
  NonNullable<ResilienceObservationV1["journalPhase"]>;

const ResilienceTelemetryContractErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "inconsistent_evidence",
  "inconsistent_failure_class",
  "missing_phase_evidence",
]);

export class ResilienceTelemetryContractError extends Schema.TaggedErrorClass<ResilienceTelemetryContractError>()(
  "ResilienceTelemetryContractError",
  {
    code: ResilienceTelemetryContractErrorCodeSchema,
    field: Schema.String,
  },
) {}

export const decodeResilienceObservation = Effect.fn(
  "agentos.resilienceTelemetry.decodeObservation",
)(function*(input: unknown) {
  const observation = yield* Schema.decodeUnknownEffect(
    ResilienceObservationV1Schema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => contractError("invalid_contract", "$")),
  );
  yield* validateEvidence(observation);
  yield* validateFailureClass(observation);
  yield* validatePhaseEvidence(observation);
  return observation;
});

export function resilienceMetricAttributes(
  observation: ResilienceObservationV1,
): AgentOSTelemetryAttributes {
  return {
    "agentos.telemetry.contract.version": observation.version,
    "agentos.resilience.source": observation.source,
    "agentos.resilience.phase": observation.phase,
    "agentos.resilience.evidence": observation.evidence,
    "agentos.resilience.outcome": observation.outcome,
    "agentos.resilience.cause": observation.cause,
    ...(observation.failureClass === null
      ? {}
      : { "agentos.resilience.failure.class": observation.failureClass }),
    "agentos.resilience.recovery": observation.recovery,
    "agentos.resilience.attempt": observation.attempt,
    ...(observation.topologyAction === null
      ? {}
      : { "agentos.resilience.topology.action": observation.topologyAction }),
    ...(observation.topologyReason === null
      ? {}
      : { "agentos.resilience.topology.reason": observation.topologyReason }),
    ...(observation.runtimeAction === null
      ? {}
      : { "agentos.resilience.runtime.action": observation.runtimeAction }),
    ...(observation.workloadProfile === null
      ? {}
      : { "agentos.resilience.workload.profile": observation.workloadProfile }),
    ...(observation.workloadSpecVersion === null
      ? {}
      : {
        "agentos.resilience.workload.spec_version":
          observation.workloadSpecVersion,
      }),
    ...(observation.journalPhase === null
      ? {}
      : { "agentos.resilience.journal.phase": observation.journalPhase }),
    ...(observation.protocol === null
      ? {}
      : { "agentos.resilience.protocol": observation.protocol }),
  };
}

export function resilienceProtectedAttributes(
  observation: ResilienceObservationV1,
): AgentOSTelemetryAttributes {
  return {
    ...resilienceMetricAttributes(observation),
    "agentos.identity.agent_id": observation.protected.agentId,
    "agentos.resilience.operation.id": observation.protected.operationId,
    ...(observation.protected.assignmentId === null
      ? {}
      : {
        "agentos.identity.assignment_id":
          observation.protected.assignmentId,
      }),
    ...(observation.protected.proposalId === null
      ? {}
      : {
        "agentos.resilience.topology.proposal_id":
          observation.protected.proposalId,
      }),
    ...(observation.protected.podUid === null
      ? {}
      : { "agentos.resilience.pod.uid": observation.protected.podUid }),
    ...(observation.protected.pvcUid === null
      ? {}
      : { "agentos.resilience.pvc.uid": observation.protected.pvcUid }),
    ...(observation.protected.sessionId === null
      ? {}
      : {
        "agentos.resilience.session.id":
          observation.protected.sessionId,
      }),
    ...(observation.protected.protocolId === null
      ? {}
      : {
        "agentos.resilience.protocol.id":
          observation.protected.protocolId,
      }),
    ...(observation.workloadSpecDigest === null
      ? {}
      : {
        "agentos.resilience.workload.spec_digest":
          observation.workloadSpecDigest,
      }),
    ...(observation.workloadOverlayDigest === null
      ? {}
      : {
        "agentos.resilience.workload.overlay_digest":
          observation.workloadOverlayDigest,
      }),
    ...(observation.renderedManifestDigest === null
      ? {}
      : {
        "agentos.resilience.workload.render_digest":
          observation.renderedManifestDigest,
      }),
  };
}

const validateEvidence = Effect.fn(
  "agentos.resilienceTelemetry.validateEvidence",
)(function*(observation: ResilienceObservationV1) {
  if (observation.evidence === "unobserved") {
    if (
      observation.outcome !== "unobserved" ||
      observation.cause !== "none" ||
      observation.recovery !== "unobserved"
    ) {
      return yield* contractError("inconsistent_evidence", "$.evidence");
    }
    return;
  }
  if (
    observation.outcome === "unobserved" ||
    observation.recovery === "unobserved"
  ) {
    return yield* contractError("inconsistent_evidence", "$.outcome");
  }
});

const validatePhaseEvidence = Effect.fn(
  "agentos.resilienceTelemetry.validatePhaseEvidence",
)(function*(observation: ResilienceObservationV1) {
  if (observation.phase === "topology_decision") {
    if (
      observation.source !== "topology_plan" ||
      observation.topologyAction === null ||
      observation.topologyReason === null
    ) {
      return yield* contractError(
        "missing_phase_evidence",
        "$.topologyAction",
      );
    }
  } else if (
    observation.topologyAction !== null ||
    observation.topologyReason !== null
  ) {
    return yield* contractError(
      "missing_phase_evidence",
      "$.topologyAction",
    );
  }

  if (
    observation.phase === "workload_plan" ||
    observation.source === "workload_plan"
  ) {
    if (
      observation.workloadProfile === null ||
      observation.workloadSpecVersion === null ||
      observation.workloadSpecDigest === null ||
      observation.workloadOverlayDigest === null
    ) {
      return yield* contractError(
        "missing_phase_evidence",
        "$.workloadSpecDigest",
      );
    }
  }

  if (
    (observation.source === "runtime_journal") !==
      (observation.journalPhase !== null)
  ) {
    return yield* contractError(
      "missing_phase_evidence",
      "$.journalPhase",
    );
  }

  if (observation.phase === "protocol") {
    if (
      observation.protocol === null ||
      observation.source !== observation.protocol
    ) {
      return yield* contractError("missing_phase_evidence", "$.protocol");
    }
  } else if (observation.protocol !== null) {
    return yield* contractError("missing_phase_evidence", "$.protocol");
  }
});

const validateFailureClass = Effect.fn(
  "agentos.resilienceTelemetry.validateFailureClass",
)(function*(observation: ResilienceObservationV1) {
  if (
    (observation.cause === "retry_exhausted") !==
      (observation.failureClass !== null)
  ) {
    return yield* contractError(
      "inconsistent_failure_class",
      "$.failureClass",
    );
  }
});

function contractError(
  code: ResilienceTelemetryContractError["code"],
  field: string,
) {
  return new ResilienceTelemetryContractError({ code, field });
}
