import { Crypto, Effect, Encoding, Schema } from "effect";

import { NonBlankStringSchema } from "../shared/contracts.ts";

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(55),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const Summary = NonBlankStringSchema.pipe(Schema.check(Schema.isMaxLength(240)));
const Scope = NonBlankStringSchema.pipe(Schema.check(Schema.isMaxLength(4_000)));
const DisplayName = NonBlankStringSchema.pipe(
  Schema.check(Schema.isMaxLength(128)),
);
const Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);

export const SECOND_MATE_TOPOLOGY_ACTIONS = values(
  "expand",
  "modify",
  "shrink",
  "split",
  "merge",
  "retire",
);
export const SecondMateTopologyActionV1Schema = Schema.Literals(
  SECOND_MATE_TOPOLOGY_ACTIONS,
);

export const SECOND_MATE_TOPOLOGY_REASONS = values(
  "persistent_load",
  "routing_ambiguity",
  "charter_overlap",
  "cross_domain_escalation",
  "dependency_coupling",
  "repeated_failure",
  "capacity_pressure",
  "cost_pressure",
  "durable_idle",
  "delivery_degradation",
  "captain_direction",
);
export const SecondMateTopologyReasonV1Schema = Schema.Literals(
  SECOND_MATE_TOPOLOGY_REASONS,
);

export const SecondMateTopologySignalAuthorityV1Schema = Schema.Literals([
  "postgresql",
  "kubernetes",
  "herdr",
  "otel",
]);

export const SecondMateTopologySignalKindV1Schema = Schema.Literals([
  "assignment_load",
  "backlog_load",
  "routing_ambiguity",
  "handoff_frequency",
  "cross_domain_escalation",
  "dependency_coupling",
  "failure_rate",
  "capacity_headroom",
  "cost_pressure",
  "idle_duration",
  "delivery_health",
]);

export class SecondMateCharterV1 extends Schema.Class<SecondMateCharterV1>(
  "SecondMateCharterV1",
)({
  version: Schema.Literal(1),
  summary: Summary,
  scope: Scope,
  projectAccess: Schema.Literal("non_exclusive"),
  crossDomainRouting: Schema.Literal("common_ancestor"),
}) {}

export class SecondMateTopologySignalV1 extends Schema.Class<SecondMateTopologySignalV1>(
  "SecondMateTopologySignalV1",
)({
  authority: SecondMateTopologySignalAuthorityV1Schema,
  kind: SecondMateTopologySignalKindV1Schema,
  observation: Schema.Literals(["observed", "unobserved"]),
  trend: Schema.Literals([
    "rising",
    "stable",
    "falling",
    "degrading",
    "improving",
    "unknown",
  ]),
}) {}

export class SecondMateTopologySourceV1 extends Schema.Class<SecondMateTopologySourceV1>(
  "SecondMateTopologySourceV1",
)({
  agentId: Uuid,
  expectedCharter: SecondMateCharterV1,
}) {}

export class ExistingSecondMateTopologyDestinationV1 extends Schema.Class<ExistingSecondMateTopologyDestinationV1>(
    "ExistingSecondMateTopologyDestinationV1",
  )({
    kind: Schema.Literal("existing"),
    agentId: Uuid,
    desiredCharter: SecondMateCharterV1,
  }) {}

export class NewSecondMateTopologyDestinationV1 extends Schema.Class<NewSecondMateTopologyDestinationV1>(
    "NewSecondMateTopologyDestinationV1",
  )({
    kind: Schema.Literal("new"),
    handle: KubernetesName,
    displayName: DisplayName,
    desiredCharter: SecondMateCharterV1,
  }) {}

export const SecondMateTopologyDestinationV1Schema = Schema.Union([
  ExistingSecondMateTopologyDestinationV1,
  NewSecondMateTopologyDestinationV1,
]);

export class SecondMateTopologyProposalV1 extends Schema.Class<SecondMateTopologyProposalV1>(
  "SecondMateTopologyProposalV1",
)({
  version: Schema.Literal(1),
  proposalId: Uuid,
  proposedByAgentId: Uuid,
  action: SecondMateTopologyActionV1Schema,
  observedAtMillis: EpochMillis,
  validUntilMillis: EpochMillis,
  sources: Schema.Array(SecondMateTopologySourceV1).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  ),
  destinations: Schema.Array(SecondMateTopologyDestinationV1Schema).pipe(
    Schema.check(Schema.isMaxLength(2)),
  ),
  reasons: Schema.Array(SecondMateTopologyReasonV1Schema).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  ),
  signals: Schema.Array(SecondMateTopologySignalV1).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  ),
  invariants: Schema.Struct({
    projectAccess: Schema.Literal("non_exclusive"),
    crossDomainRouting: Schema.Literal("common_ancestor"),
    lateralDelivery: Schema.Literal("forbidden"),
    automaticScheduling: Schema.Literal("forbidden"),
  }),
}) {}

export const CompiledSecondMateTopologyPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  proposal: SecondMateTopologyProposalV1,
  digest: Digest,
});

export type SecondMateTopologyActionV1 =
  typeof SecondMateTopologyActionV1Schema.Type;
export type SecondMateTopologyReasonV1 =
  typeof SecondMateTopologyReasonV1Schema.Type;
export type CompiledSecondMateTopologyPlanV1 =
  typeof CompiledSecondMateTopologyPlanV1Schema.Type;

const SecondMateTopologyPlanErrorCode = Schema.Literals([
  "invalid_contract",
  "invalid_timing",
  "duplicate_reference",
  "invalid_action_shape",
  "telemetry_only_evidence",
  "no_change",
  "hash_failed",
]);

export class SecondMateTopologyPlanError extends Schema.TaggedErrorClass<SecondMateTopologyPlanError>()(
  "SecondMateTopologyPlanError",
  {
    code: SecondMateTopologyPlanErrorCode,
    field: Schema.String,
    message: Schema.String,
  },
) {}

const maximumReviewWindowMillis = 30 * 86_400_000;

export const compileSecondMateTopologyPlan = Effect.fn(
  "agentos.secondMateTopology.compile",
)(function*(input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(
    SecondMateTopologyProposalV1,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() =>
      planError(
        "invalid_contract",
        "$",
        "Second Mate topology proposal does not match the closed v1 contract",
      ),
    ),
  );
  const normalized = normalizeProposal(decoded);
  yield* validateTiming(normalized);
  yield* validateReferences(normalized);
  yield* validateEvidence(normalized);
  yield* validateAction(normalized);

  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(SecondMateTopologyProposalV1),
  )(normalized).pipe(
    Effect.mapError(() =>
      planError(
        "invalid_contract",
        "$",
        "Validated Second Mate topology proposal could not be encoded",
      ),
    ),
  );
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(encoded),
  ).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError(() =>
      planError(
        "hash_failed",
        "$",
        "Second Mate topology proposal digest could not be computed",
      ),
    ),
  );

  return {
    version: 1,
    proposal: normalized,
    digest,
  } satisfies CompiledSecondMateTopologyPlanV1;
});

const validateTiming = Effect.fn(
  "agentos.secondMateTopology.validateTiming",
)(function*(proposal: SecondMateTopologyProposalV1) {
  const duration = proposal.validUntilMillis - proposal.observedAtMillis;
  if (duration <= 0 || duration > maximumReviewWindowMillis) {
    return yield* planError(
      "invalid_timing",
      "$.validUntilMillis",
      "Topology review validity must be later than observation and at most 30 days",
    );
  }
});

const validateReferences = Effect.fn(
  "agentos.secondMateTopology.validateReferences",
)(function*(proposal: SecondMateTopologyProposalV1) {
  const sourceIds = proposal.sources.map(({ agentId }) => agentId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    return yield* planError(
      "duplicate_reference",
      "$.sources",
      "Topology proposal source Agents must be unique",
    );
  }

  const destinationKeys = proposal.destinations.map(destinationKey);
  if (new Set(destinationKeys).size !== destinationKeys.length) {
    return yield* planError(
      "duplicate_reference",
      "$.destinations",
      "Topology proposal destinations must be unique",
    );
  }
  if (new Set(proposal.reasons).size !== proposal.reasons.length) {
    return yield* planError(
      "duplicate_reference",
      "$.reasons",
      "Topology proposal reason classes must be unique",
    );
  }
  const signalKeys = proposal.signals.map(signalKey);
  if (new Set(signalKeys).size !== signalKeys.length) {
    return yield* planError(
      "duplicate_reference",
      "$.signals",
      "Topology proposal signals must be unique by authority and kind",
    );
  }
});

const validateEvidence = Effect.fn(
  "agentos.secondMateTopology.validateEvidence",
)(function*(proposal: SecondMateTopologyProposalV1) {
  if (
    !proposal.signals.some(
      ({ authority, observation }) =>
        authority !== "otel" && observation === "observed",
    )
  ) {
    return yield* planError(
      "telemetry_only_evidence",
      "$.signals",
      "Topology changes require observed PostgreSQL, Kubernetes, or Herdr evidence",
    );
  }
});

const validateAction = Effect.fn(
  "agentos.secondMateTopology.validateAction",
)(function*(proposal: SecondMateTopologyProposalV1) {
  switch (proposal.action) {
    case "expand":
    case "modify":
    case "shrink":
      return yield* validateSingleMateChange(proposal);
    case "split":
      return yield* validateSplit(proposal);
    case "merge":
      return yield* validateMerge(proposal);
    case "retire":
      if (proposal.sources.length !== 1 || proposal.destinations.length !== 0) {
        return yield* actionShapeError(proposal.action);
      }
  }
});

function validateSingleMateChange(proposal: SecondMateTopologyProposalV1) {
  return Effect.gen(function*() {
    const source = proposal.sources[0];
    const destination = proposal.destinations[0];
    if (
      source === undefined ||
      destination === undefined ||
      proposal.sources.length !== 1 ||
      proposal.destinations.length !== 1 ||
      destination.kind !== "existing" ||
      destination.agentId !== source.agentId
    ) {
      return yield* actionShapeError(proposal.action);
    }
    if (chartersEqual(source.expectedCharter, destination.desiredCharter)) {
      return yield* planError(
        "no_change",
        "$.destinations[0].desiredCharter",
        "Expand, modify, and shrink require a changed charter",
      );
    }
  });
}

function validateSplit(proposal: SecondMateTopologyProposalV1) {
  return Effect.gen(function*() {
    const source = proposal.sources[0];
    const existing = proposal.destinations.find(
      (destination) => destination.kind === "existing",
    );
    const added = proposal.destinations.find(
      (destination) => destination.kind === "new",
    );
    if (
      source === undefined ||
      proposal.sources.length !== 1 ||
      proposal.destinations.length !== 2 ||
      existing === undefined ||
      added === undefined ||
      existing.agentId !== source.agentId
    ) {
      return yield* actionShapeError(proposal.action);
    }
    if (chartersEqual(source.expectedCharter, existing.desiredCharter)) {
      return yield* planError(
        "no_change",
        "$.destinations",
        "Split requires a changed source charter and one new broad domain",
      );
    }
  });
}

function validateMerge(proposal: SecondMateTopologyProposalV1) {
  return Effect.gen(function*() {
    const destination = proposal.destinations[0];
    if (
      proposal.sources.length !== 2 ||
      proposal.destinations.length !== 1 ||
      destination === undefined ||
      destination.kind !== "existing" ||
      !proposal.sources.some(({ agentId }) => agentId === destination.agentId)
    ) {
      return yield* actionShapeError(proposal.action);
    }
  });
}

function normalizeProposal(
  proposal: SecondMateTopologyProposalV1,
): SecondMateTopologyProposalV1 {
  return SecondMateTopologyProposalV1.make({
    ...proposal,
    sources: [...proposal.sources].sort((left, right) =>
      left.agentId.localeCompare(right.agentId)
    ),
    destinations: [...proposal.destinations].sort((left, right) =>
      destinationKey(left).localeCompare(destinationKey(right))
    ),
    reasons: [...proposal.reasons].sort(),
    signals: [...proposal.signals].sort((left, right) =>
      signalKey(left).localeCompare(signalKey(right))
    ),
  });
}

function destinationKey(
  destination:
    | ExistingSecondMateTopologyDestinationV1
    | NewSecondMateTopologyDestinationV1,
) {
  return destination.kind === "existing"
    ? `existing:${destination.agentId}`
    : `new:${destination.handle}`;
}

function signalKey(signal: SecondMateTopologySignalV1) {
  return `${signal.authority}:${signal.kind}`;
}

function chartersEqual(
  left: SecondMateCharterV1,
  right: SecondMateCharterV1,
) {
  return left.version === right.version &&
    left.summary === right.summary &&
    left.scope === right.scope &&
    left.projectAccess === right.projectAccess &&
    left.crossDomainRouting === right.crossDomainRouting;
}

function actionShapeError(action: SecondMateTopologyActionV1) {
  return planError(
    "invalid_action_shape",
    "$.destinations",
    `Second Mate topology action ${action} has an invalid source/destination shape`,
  );
}

function planError(
  code: SecondMateTopologyPlanError["code"],
  field: string,
  message: string,
) {
  return SecondMateTopologyPlanError.make({ code, field, message });
}
