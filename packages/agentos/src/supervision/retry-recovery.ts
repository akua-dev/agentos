import { Effect, Schema } from "effect";

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

export const ASSIGNMENT_EXECUTION_FAILURE_CLASSES = values(
  "overload",
  "authentication",
  "transport",
  "protocol",
  "stream",
  "capacity",
  "policy",
  "provider",
  "harness",
  "runtime",
);

export const ASSIGNMENT_EXECUTION_STATES = values(
  "active",
  "exhausted",
  "completed",
  "resumed",
  "reassigned",
  "stopped",
);

export const ASSIGNMENT_EXECUTION_RECOVERY_ACTIONS = values(
  "resume",
  "reassign",
  "stop",
);

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const NativeSessionRefSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z_.:@/-]+$/),
  ),
);
const RetryCountSchema = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(5),
  ),
);

export const AssignmentExecutionEpochObservationV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(ASSIGNMENT_EXECUTION_STATES),
  failureClass: Schema.NullOr(
    Schema.Literals(ASSIGNMENT_EXECUTION_FAILURE_CLASSES),
  ),
  retryCeiling: Schema.NullOr(RetryCountSchema),
  attemptsObserved: Schema.NullOr(RetryCountSchema),
  recoveryAction: Schema.NullOr(
    Schema.Literals(ASSIGNMENT_EXECUTION_RECOVERY_ACTIONS),
  ),
  agentId: UuidSchema,
  assignmentId: UuidSchema,
  operationId: UuidSchema,
  nativeSessionRef: NativeSessionRefSchema,
  replacementAssignmentId: Schema.NullOr(UuidSchema),
});

export type AssignmentExecutionFailureClass =
  typeof ASSIGNMENT_EXECUTION_FAILURE_CLASSES[number];
export type AssignmentExecutionEpochObservationV1 =
  typeof AssignmentExecutionEpochObservationV1Schema.Type;

const AssignmentExecutionRecoveryErrorCodeSchema = Schema.Literals([
  "invalid_observation",
  "inconsistent_state",
]);

export class AssignmentExecutionRecoveryError extends Schema.TaggedErrorClass<AssignmentExecutionRecoveryError>()(
  "AssignmentExecutionRecoveryError",
  {
    code: AssignmentExecutionRecoveryErrorCodeSchema,
    field: Schema.String,
  },
) {}

export const decodeAssignmentExecutionEpochObservation = Effect.fn(
  "agentos.assignmentExecution.decodeObservation",
)(function*(input: unknown) {
  const observation = yield* Schema.decodeUnknownEffect(
    AssignmentExecutionEpochObservationV1Schema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => recoveryError("invalid_observation", "$")),
  );
  yield* validateAssignmentExecutionEpochObservation(observation);
  return observation;
});

const validateAssignmentExecutionEpochObservation = Effect.fn(
  "agentos.assignmentExecution.validateObservation",
)(function*(observation: AssignmentExecutionEpochObservationV1) {
  if (
    observation.state === "active" || observation.state === "completed"
  ) {
    if (
      observation.failureClass !== null ||
      observation.retryCeiling !== null ||
      observation.attemptsObserved !== null ||
      observation.recoveryAction !== null ||
      observation.replacementAssignmentId !== null
    ) {
      return yield* Effect.fail(
        recoveryError("inconsistent_state", "$.state"),
      );
    }
    return yield* Effect.void;
  }

  const derivedCeiling = observation.failureClass === null
    ? null
    : retryCeilingFor(observation.failureClass);
  if (
    observation.failureClass === null ||
    observation.retryCeiling !== derivedCeiling ||
    observation.attemptsObserved !== derivedCeiling
  ) {
    return yield* Effect.fail(
      recoveryError("inconsistent_state", "$.retryCeiling"),
    );
  }

  switch (observation.state) {
    case "exhausted":
      return yield* (observation.recoveryAction === null &&
          observation.replacementAssignmentId === null
        ? Effect.void
        : Effect.fail(recoveryError("inconsistent_state", "$.recoveryAction")));
    case "resumed":
      return yield* (observation.recoveryAction === "resume" &&
          observation.replacementAssignmentId === null
        ? Effect.void
        : Effect.fail(recoveryError("inconsistent_state", "$.recoveryAction")));
    case "reassigned":
      return yield* (observation.recoveryAction === "reassign" &&
          observation.replacementAssignmentId !== null
        ? Effect.void
        : Effect.fail(recoveryError("inconsistent_state", "$.recoveryAction")));
    case "stopped":
      return yield* (observation.recoveryAction === "stop" &&
          observation.replacementAssignmentId === null
        ? Effect.void
        : Effect.fail(recoveryError("inconsistent_state", "$.recoveryAction")));
  }
});

function retryCeilingFor(
  failureClass: AssignmentExecutionFailureClass,
): 1 | 2 | 3 | 5 {
  switch (failureClass) {
    case "overload":
    case "transport":
      return 5;
    case "stream":
      return 3;
    case "protocol":
    case "provider":
    case "harness":
    case "runtime":
      return 2;
    case "authentication":
    case "policy":
    case "capacity":
      return 1;
  }
}

function recoveryError(
  code: AssignmentExecutionRecoveryError["code"],
  field: string,
) {
  return new AssignmentExecutionRecoveryError({ code, field });
}
