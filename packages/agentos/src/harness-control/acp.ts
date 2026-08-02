import { Effect, Schema } from "effect";

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const QualifiedNameSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9@._:/-]+$/),
  ),
);
const KubernetesNameSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const AbsolutePathSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096), Schema.isPattern(/^\//)),
);
const SessionIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(2_048)),
);
const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

export const HarnessProviderV1Schema = Schema.Literals(["pi", "codex"]);
export const HarnessControlModeV1Schema = Schema.Literals(["native", "acp"]);

export class PiNativeSessionRefV1 extends Schema.Class<PiNativeSessionRefV1>(
  "PiNativeSessionRefV1",
)({
  provider: Schema.Literal("pi"),
  referenceKind: Schema.Literal("path"),
  value: AbsolutePathSchema,
}) {}

export class CodexNativeSessionRefV1 extends Schema.Class<CodexNativeSessionRefV1>(
  "CodexNativeSessionRefV1",
)({
  provider: Schema.Literal("codex"),
  referenceKind: Schema.Literal("id"),
  value: SessionIdSchema,
}) {}

export const HarnessNativeSessionRefV1Schema = Schema.Union([
  PiNativeSessionRefV1,
  CodexNativeSessionRefV1,
]);

export class HarnessCorrelationV1 extends Schema.Class<HarnessCorrelationV1>(
  "HarnessCorrelationV1",
)({
  version: Schema.Literal(1),
  agentId: UuidSchema,
  assignmentId: UuidSchema,
  herdrSession: QualifiedNameSchema,
  herdrAgentName: KubernetesNameSchema,
  workspace: AbsolutePathSchema,
  nativeSession: HarnessNativeSessionRefV1Schema,
  protocolSessionId: Schema.optionalKey(SessionIdSchema),
  sessionAuthority: Schema.Literal("provider_native"),
}) {}

export class HarnessWriterV1 extends Schema.Class<HarnessWriterV1>(
  "HarnessWriterV1",
)({
  version: Schema.Literal(1),
  writerId: QualifiedNameSchema,
  mode: HarnessControlModeV1Schema,
  custody: Schema.Literal("herdr"),
  nativeSessionValue: SessionIdSchema,
}) {}

const HarnessControlRequestV1Schema = Schema.Struct({
  expectedGeneration: NonNegativeIntegerSchema,
  reason: Schema.Literals([
    "operator_handoff",
    "adapter_loss",
    "replacement",
    "wake",
  ]),
  targetMode: HarnessControlModeV1Schema,
});

export class HarnessControlPlanInputV1 extends Schema.Class<HarnessControlPlanInputV1>(
  "HarnessControlPlanInputV1",
)({
  version: Schema.Literal(1),
  correlation: HarnessCorrelationV1,
  generation: NonNegativeIntegerSchema,
  nativeSessionAvailable: Schema.Boolean,
  recordedWriter: HarnessWriterV1,
  observedWriters: Schema.Array(HarnessWriterV1).pipe(
    Schema.check(Schema.isMaxLength(2)),
  ),
  request: HarnessControlRequestV1Schema,
}) {}

const HarnessControlActionV1Schema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("mark_not_ready") }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("stop_writer"),
    writerId: QualifiedNameSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("verify_writer_exit"),
    writerId: QualifiedNameSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("start_writer"),
    mode: HarnessControlModeV1Schema,
    nativeSessionValue: SessionIdSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("wake_writer"),
    writerId: QualifiedNameSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("verify_single_writer"),
    mode: HarnessControlModeV1Schema,
    nativeSessionValue: SessionIdSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("persist_correlation"),
    generation: NonNegativeIntegerSchema,
  }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("mark_ready") }),
]);

export const HarnessControlPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  correlation: HarnessCorrelationV1,
  previousGeneration: NonNegativeIntegerSchema,
  nextGeneration: NonNegativeIntegerSchema,
  actions: Schema.Array(HarnessControlActionV1Schema).pipe(
    Schema.check(Schema.isMinLength(2), Schema.isMaxLength(7)),
  ),
  invariants: Schema.Struct({
    sessionAuthority: Schema.Literal("provider_native"),
    maximumActiveWriters: Schema.Literal(1),
    handoffOrdering: Schema.Literal("stop_verify_start"),
    promptQueue: Schema.Literal("forbidden"),
    transcriptStorage: Schema.Literal("forbidden"),
  }),
});

export type HarnessProviderV1 = typeof HarnessProviderV1Schema.Type;
export type HarnessControlModeV1 = typeof HarnessControlModeV1Schema.Type;
export type HarnessNativeSessionRefV1 =
  typeof HarnessNativeSessionRefV1Schema.Type;
export type HarnessControlPlanV1 = typeof HarnessControlPlanV1Schema.Type;

const HarnessControlPlanErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "stale_generation",
  "native_session_missing",
  "multiple_active_writers",
  "writer_missing",
  "writer_mismatch",
  "adapter_still_active",
  "invalid_transition",
]);

export class HarnessControlPlanError extends Schema.TaggedErrorClass<HarnessControlPlanError>()(
  "HarnessControlPlanError",
  {
    code: HarnessControlPlanErrorCodeSchema,
    message: Schema.String,
  },
) {}

export class AcpControlEventError extends Schema.TaggedErrorClass<AcpControlEventError>()(
  "AcpControlEventError",
  {
    code: Schema.Literal("invalid_control_event"),
    message: Schema.String,
  },
) {}

export const AcpControlEventV1Schema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("permission"),
    sessionId: SessionIdSchema,
    requestId: QualifiedNameSchema,
    toolCallId: QualifiedNameSchema,
    phase: Schema.Literals(["requested", "selected", "cancelled"]),
    optionId: Schema.optionalKey(QualifiedNameSchema),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("cancellation"),
    sessionId: SessionIdSchema,
    source: Schema.Literals(["client", "replacement", "shutdown"]),
    phase: Schema.Literals(["requested", "completed"]),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("tool"),
    sessionId: SessionIdSchema,
    toolCallId: QualifiedNameSchema,
    status: Schema.Literals(["pending", "in_progress", "completed", "failed"]),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("plan"),
    sessionId: SessionIdSchema,
    revision: NonNegativeIntegerSchema,
    entryCount: NonNegativeIntegerSchema,
    status: Schema.Literals(["created", "updated", "completed", "removed"]),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("error"),
    sessionId: SessionIdSchema,
    code: QualifiedNameSchema,
    retryability: Schema.Literals(["retryable", "terminal"]),
  }),
]);

export type AcpControlEventV1 = typeof AcpControlEventV1Schema.Type;

export const decodeHarnessCorrelation = Effect.fn(
  "agentos.harnessControl.decodeCorrelation",
)(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(HarnessCorrelationV1, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() =>
      planError(
        "invalid_contract",
        "Harness correlation must match the closed metadata-only v1 contract",
      ),
    ),
  );
});

export const decodeAcpControlEvent = Effect.fn(
  "agentos.harnessControl.decodeEvent",
)(function*(input: unknown) {
  return yield* Schema.decodeUnknownEffect(AcpControlEventV1Schema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() =>
      AcpControlEventError.make({
        code: "invalid_control_event",
        message: "ACP control metadata must match the closed content-free v1 event contract",
      }),
    ),
  );
});

export const compileHarnessControlPlan = Effect.fn(
  "agentos.harnessControl.compilePlan",
)(function*(input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(HarnessControlPlanInputV1, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() =>
      planError(
        "invalid_contract",
        "Harness custody transition must match the closed v1 contract",
      ),
    ),
  );

  if (decoded.request.expectedGeneration !== decoded.generation) {
    return yield* planError(
      "stale_generation",
      "Harness custody generation changed before this transition",
    );
  }
  if (!decoded.nativeSessionAvailable) {
    return yield* planError(
      "native_session_missing",
      "Provider-native session must exist before control can be handed off or recovered",
    );
  }
  if (
    decoded.recordedWriter.nativeSessionValue !==
      decoded.correlation.nativeSession.value
  ) {
    return yield* planError(
      "writer_mismatch",
      "Recorded writer does not own the correlated provider-native session",
    );
  }
  if (decoded.observedWriters.length > 1) {
    return yield* planError(
      "multiple_active_writers",
      "Refusing harness control while more than one active writer is observed",
    );
  }

  const observed = decoded.observedWriters[0];
  if (observed === undefined) {
    if (
      decoded.request.reason !== "adapter_loss" ||
      decoded.recordedWriter.mode !== "acp" ||
      decoded.request.targetMode !== "native"
    ) {
      return yield* planError(
        "writer_missing",
        "Zero-writer recovery is allowed only for an exited ACP adapter returning to native control",
      );
    }
    return recoveryPlan(decoded);
  }

  if (!sameWriter(observed, decoded.recordedWriter)) {
    return yield* planError(
      "writer_mismatch",
      "Observed Herdr writer does not match the recorded custody lease",
    );
  }
  if (decoded.request.reason === "adapter_loss") {
    return yield* planError(
      "adapter_still_active",
      "Native fallback cannot start until Herdr observes the ACP writer exited",
    );
  }
  if (decoded.request.reason === "wake") {
    if (decoded.request.targetMode !== observed.mode) {
      return yield* planError(
        "invalid_transition",
        "Wake cannot change the active harness control mode",
      );
    }
    return wakePlan(decoded, observed);
  }
  if (
    decoded.request.reason === "operator_handoff" &&
    decoded.request.targetMode === observed.mode
  ) {
    return yield* planError(
      "invalid_transition",
      "Operator handoff must change the active harness control mode",
    );
  }

  return handoffPlan(decoded, observed);
});

function sameWriter(left: HarnessWriterV1, right: HarnessWriterV1) {
  return left.writerId === right.writerId &&
    left.mode === right.mode &&
    left.custody === right.custody &&
    left.nativeSessionValue === right.nativeSessionValue;
}

function invariants(): HarnessControlPlanV1["invariants"] {
  return {
    sessionAuthority: "provider_native",
    maximumActiveWriters: 1,
    handoffOrdering: "stop_verify_start",
    promptQueue: "forbidden",
    transcriptStorage: "forbidden",
  };
}

function recoveryPlan(
  input: HarnessControlPlanInputV1,
): HarnessControlPlanV1 {
  const generation = input.generation + 1;
  const nativeSessionValue = input.correlation.nativeSession.value;
  return {
    version: 1,
    correlation: input.correlation,
    previousGeneration: input.generation,
    nextGeneration: generation,
    actions: [
      { version: 1, kind: "mark_not_ready" },
      {
        version: 1,
        kind: "start_writer",
        mode: "native",
        nativeSessionValue,
      },
      {
        version: 1,
        kind: "verify_single_writer",
        mode: "native",
        nativeSessionValue,
      },
      { version: 1, kind: "persist_correlation", generation },
      { version: 1, kind: "mark_ready" },
    ],
    invariants: invariants(),
  };
}

function wakePlan(
  input: HarnessControlPlanInputV1,
  observed: HarnessWriterV1,
): HarnessControlPlanV1 {
  return {
    version: 1,
    correlation: input.correlation,
    previousGeneration: input.generation,
    nextGeneration: input.generation,
    actions: [
      { version: 1, kind: "wake_writer", writerId: observed.writerId },
      {
        version: 1,
        kind: "verify_single_writer",
        mode: observed.mode,
        nativeSessionValue: observed.nativeSessionValue,
      },
    ],
    invariants: invariants(),
  };
}

function handoffPlan(
  input: HarnessControlPlanInputV1,
  observed: HarnessWriterV1,
): HarnessControlPlanV1 {
  const generation = input.generation + 1;
  const nativeSessionValue = input.correlation.nativeSession.value;
  return {
    version: 1,
    correlation: input.correlation,
    previousGeneration: input.generation,
    nextGeneration: generation,
    actions: [
      { version: 1, kind: "mark_not_ready" },
      { version: 1, kind: "stop_writer", writerId: observed.writerId },
      {
        version: 1,
        kind: "verify_writer_exit",
        writerId: observed.writerId,
      },
      {
        version: 1,
        kind: "start_writer",
        mode: input.request.targetMode,
        nativeSessionValue,
      },
      {
        version: 1,
        kind: "verify_single_writer",
        mode: input.request.targetMode,
        nativeSessionValue,
      },
      { version: 1, kind: "persist_correlation", generation },
      { version: 1, kind: "mark_ready" },
    ],
    invariants: invariants(),
  };
}

function planError(
  code: HarnessControlPlanError["code"],
  message: string,
) {
  return HarnessControlPlanError.make({ code, message });
}
