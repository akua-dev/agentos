import { Effect, Schema } from "effect";

import { NonBlankStringSchema } from "../shared/contracts.ts";

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const SkillIdSchema = NonBlankStringSchema.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9._-]*@v[1-9][0-9]*$/),
  ),
);
const SubjectSchema = NonBlankStringSchema.pipe(
  Schema.check(Schema.isMaxLength(240)),
);
const DescriptionSchema = NonBlankStringSchema.pipe(
  Schema.check(Schema.isMaxLength(512)),
);
const TargetHandleSchema = NonBlankStringSchema.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const AgentVersionSchema = NonBlankStringSchema.pipe(
  Schema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  ),
);
const HttpsBaseUrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/),
  ),
);
const EpochMillisSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const ReferenceMediaType = "application/vnd.agentos.inbox-reference+json";

export const A2aSpeechActV1Schema = Schema.Literals([
  "answer",
  "approval",
  "approval_request",
  "captain_decision",
  "captain_decision_answer",
  "escalation",
  "notification",
  "question",
  "request",
]);

const AuthorizationDecisionSchema = Schema.Literals(["allowed", "denied"]);
const AssignmentAuthorizationDecisionSchema = Schema.Literals([
  "allowed",
  "denied",
  "not_scoped",
]);

const A2aAuthoritativeReferenceV1Schema = Schema.Struct({
  inboxId: UuidSchema,
  taskId: Schema.NullOr(UuidSchema),
  assignmentId: Schema.NullOr(UuidSchema),
  status: Schema.Literals(["pending", "committed"]),
  committedAtMillis: EpochMillisSchema,
});

const A2aAuthorizationEvidenceV1Schema = Schema.Struct({
  identity: Schema.Literals(["authenticated", "unauthenticated"]),
  caller: AuthorizationDecisionSchema,
  target: AuthorizationDecisionSchema,
  skill: AuthorizationDecisionSchema,
  hierarchyEdge: AuthorizationDecisionSchema,
  assignment: AssignmentAuthorizationDecisionSchema,
});

export class A2aDeliveryInputV1 extends Schema.Class<A2aDeliveryInputV1>(
  "A2aDeliveryInputV1",
)({
  version: Schema.Literal(1),
  authoritative: A2aAuthoritativeReferenceV1Schema,
  callerAgentId: UuidSchema,
  targetAgentId: UuidSchema,
  edge: Schema.Literals(["direct_parent_child", "lateral"]),
  speechAct: A2aSpeechActV1Schema,
  skillId: SkillIdSchema,
  subject: SubjectSchema,
  authorization: A2aAuthorizationEvidenceV1Schema,
}) {}

const A2aSkillV1Schema = Schema.Struct({
  id: SkillIdSchema,
  name: NonBlankStringSchema.pipe(Schema.check(Schema.isMaxLength(128))),
  description: DescriptionSchema,
  tags: Schema.Array(
    NonBlankStringSchema.pipe(Schema.check(Schema.isMaxLength(64))),
  ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
});

const A2aSecurityRequirementV1Schema = Schema.Struct({
  schemes: Schema.Struct({
    projectedServiceAccountBearer: Schema.Array(Schema.String),
  }),
});

export const A2aAgentCardV1Schema = Schema.Struct({
  name: TargetHandleSchema,
  description: DescriptionSchema,
  supportedInterfaces: Schema.Array(Schema.Struct({
    url: HttpsBaseUrlSchema,
    protocolBinding: Schema.Literal("JSONRPC"),
    protocolVersion: Schema.Literal("1.0"),
  })),
  version: AgentVersionSchema,
  capabilities: Schema.Struct({
    streaming: Schema.Literal(false),
    pushNotifications: Schema.Literal(false),
    extendedAgentCard: Schema.Literal(true),
  }),
  securitySchemes: Schema.Struct({
    projectedServiceAccountBearer: Schema.Struct({
      httpAuthSecurityScheme: Schema.Struct({
        description: Schema.String,
        scheme: Schema.Literal("Bearer"),
        bearerFormat: Schema.Literal("Kubernetes ServiceAccount token"),
      }),
    }),
  }),
  securityRequirements: Schema.Array(A2aSecurityRequirementV1Schema),
  defaultInputModes: Schema.Array(Schema.Literal(ReferenceMediaType)),
  defaultOutputModes: Schema.Array(Schema.Literal(ReferenceMediaType)),
  skills: Schema.Array(Schema.Struct({
    ...A2aSkillV1Schema.fields,
    inputModes: Schema.Array(Schema.Literal(ReferenceMediaType)),
    outputModes: Schema.Array(Schema.Literal(ReferenceMediaType)),
    securityRequirements: Schema.Array(A2aSecurityRequirementV1Schema),
  })),
});

export class A2aAgentCardInputV1 extends Schema.Class<A2aAgentCardInputV1>(
  "A2aAgentCardInputV1",
)({
  version: Schema.Literal(1),
  targetAgentId: UuidSchema,
  targetHandle: TargetHandleSchema,
  description: DescriptionSchema,
  agentVersion: AgentVersionSchema,
  baseUrl: HttpsBaseUrlSchema,
  skillVocabulary: Schema.Array(A2aSkillV1Schema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  reviewedSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  profileSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  ceilingSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  authorizedSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
}) {}

export class A2aPublicAgentCardInputV1 extends Schema.Class<A2aPublicAgentCardInputV1>(
  "A2aPublicAgentCardInputV1",
)({
  version: Schema.Literal(1),
  targetAgentId: UuidSchema,
  targetHandle: TargetHandleSchema,
  description: DescriptionSchema,
  agentVersion: AgentVersionSchema,
  baseUrl: HttpsBaseUrlSchema,
}) {}

const A2aHierarchyRelationshipV1Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("direct_parent_child") }),
  Schema.Struct({
    kind: Schema.Literal("cross_domain"),
    commonAncestorAgentId: UuidSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("lateral") }),
]);

export class A2aHierarchyRouteInputV1 extends Schema.Class<A2aHierarchyRouteInputV1>(
  "A2aHierarchyRouteInputV1",
)({
  version: Schema.Literal(1),
  callerAgentId: UuidSchema,
  targetAgentId: UuidSchema,
  relationship: A2aHierarchyRelationshipV1Schema,
}) {}

export const A2aTransportStatusV1Schema = Schema.Literals([
  "accepted",
  "failed",
  "timed_out",
  "cancelled",
]);
const CanonicalInboxStatusV1Schema = Schema.Literals([
  "unread",
  "read",
  "resolved",
]);

export class A2aRetryInputV1 extends Schema.Class<A2aRetryInputV1>(
  "A2aRetryInputV1",
)({
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  canonicalInbox: CanonicalInboxStatusV1Schema,
}) {}

export const A2aOutageV1Schema = Schema.Literals([
  "caller",
  "gateway",
  "authorizer",
  "target_pod",
  "adapter",
  "stream",
  "postgresql",
]);

export class A2aOutageRecoveryInputV1 extends Schema.Class<A2aOutageRecoveryInputV1>(
  "A2aOutageRecoveryInputV1",
)({
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  canonicalStatus: Schema.Literals(["pending", "committed"]),
  failure: A2aOutageV1Schema,
}) {}

export class A2aTransportResultInputV1 extends Schema.Class<A2aTransportResultInputV1>(
  "A2aTransportResultInputV1",
)({
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  transport: A2aTransportStatusV1Schema,
  canonicalInbox: CanonicalInboxStatusV1Schema,
  canonicalAssignment: Schema.Literals(["active", "completed", "ended"]),
}) {}

const A2aContractErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "canonical_row_not_committed",
  "authorization_denied",
  "hierarchy_edge_denied",
  "assignment_denied",
  "no_authorized_skills",
]);

export class A2aContractError extends Schema.TaggedErrorClass<A2aContractError>()(
  "A2aContractError",
  {
    code: A2aContractErrorCodeSchema,
    message: Schema.String,
  },
) {}

export type A2aSpeechActV1 = typeof A2aSpeechActV1Schema.Type;
export type A2aOutageV1 = typeof A2aOutageV1Schema.Type;
export type A2aTransportStatusV1 = typeof A2aTransportStatusV1Schema.Type;

export const compileA2aDeliveryRequest = Effect.fn(
  "agentos.a2a.compileDeliveryRequest",
)(function*(input: unknown) {
  const delivery = yield* decodeContract(A2aDeliveryInputV1, input);

  if (delivery.authoritative.status !== "committed") {
    return yield* contractError(
      "canonical_row_not_committed",
      "A2A delivery may begin only after the canonical Inbox row commits",
    );
  }
  if (delivery.edge !== "direct_parent_child") {
    return yield* contractError(
      "hierarchy_edge_denied",
      "A2A delivery requires one direct parent-child hierarchy edge",
    );
  }
  if (
    delivery.authorization.identity !== "authenticated" ||
    delivery.authorization.caller !== "allowed" ||
    delivery.authorization.target !== "allowed" ||
    delivery.authorization.skill !== "allowed" ||
    delivery.authorization.hierarchyEdge !== "allowed"
  ) {
    return yield* contractError(
      "authorization_denied",
      "TokenReview and OpenFGA evidence must authorize caller, target, skill, and hierarchy edge",
    );
  }
  if (
    (delivery.authoritative.assignmentId === null &&
      delivery.authorization.assignment !== "not_scoped") ||
    (delivery.authoritative.assignmentId !== null &&
      delivery.authorization.assignment !== "allowed")
  ) {
    return yield* contractError(
      "assignment_denied",
      "Assignment-scoped A2A delivery requires an active authorized Assignment",
    );
  }

  const messageId = `agentos:inbox:${delivery.authoritative.inboxId}`;
  const contextId = delivery.authoritative.taskId === null
    ? messageId
    : `agentos:task:${delivery.authoritative.taskId}`;
  const reference = {
    kind: "agentos.inbox.reference",
    version: 1,
    inboxId: delivery.authoritative.inboxId,
    taskId: delivery.authoritative.taskId,
    assignmentId: delivery.authoritative.assignmentId,
    callerAgentId: delivery.callerAgentId,
    targetAgentId: delivery.targetAgentId,
    speechAct: delivery.speechAct,
    skillId: delivery.skillId,
    subject: delivery.subject,
  };

  return {
    version: 1,
    headers: {
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
    },
    body: {
      jsonrpc: "2.0",
      id: messageId,
      method: "SendMessage",
      params: {
        message: {
          messageId,
          contextId,
          role: "ROLE_USER",
          parts: [{ data: reference, mediaType: ReferenceMediaType }],
        },
        configuration: {
          acceptedOutputModes: [ReferenceMediaType],
          historyLength: 0,
          returnImmediately: true,
        },
      },
    },
    correlation: {
      a2aContextId: contextId,
      a2aDeliveryTaskId:
        `agentos:delivery:${delivery.authoritative.inboxId}`,
      a2aMessageId: messageId,
      assignmentId: delivery.authoritative.assignmentId,
      inboxId: delivery.authoritative.inboxId,
      taskId: delivery.authoritative.taskId,
    },
    canonicalMutations: [],
    idempotencyAuthority: "agentos.inbox.id",
    persistence: "none",
  };
});

export const compileA2aAgentCard = Effect.fn(
  "agentos.a2a.compileAgentCard",
)(function*(input: unknown) {
  const card = yield* decodeContract(A2aAgentCardInputV1, input);
  const reviewed = new Set(card.reviewedSkillIds);
  const profile = new Set(card.profileSkillIds);
  const ceiling = new Set(card.ceilingSkillIds);
  const authorized = new Set(card.authorizedSkillIds);
  const skills = card.skillVocabulary
    .filter(({ id }) =>
      reviewed.has(id) &&
      profile.has(id) &&
      ceiling.has(id) &&
      authorized.has(id)
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((skill) => ({
      ...skill,
      inputModes: [ReferenceMediaType],
      outputModes: [ReferenceMediaType],
      securityRequirements: [
        { schemes: { projectedServiceAccountBearer: [] } },
      ],
    }));

  if (skills.length === 0) {
    return yield* contractError(
      "no_authorized_skills",
      "Agent Card cannot advertise a target with no effectively authorized reviewed skills",
    );
  }

  return yield* decodeContract(A2aAgentCardV1Schema, {
    name: card.targetHandle,
    description: card.description,
    supportedInterfaces: [
      {
        url: `${card.baseUrl}/agents/${card.targetAgentId}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    version: card.agentVersion,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true,
    },
    securitySchemes: {
      projectedServiceAccountBearer: {
        httpAuthSecurityScheme: {
          description: "Kubelet-rotated projected Agent ServiceAccount identity",
          scheme: "Bearer",
          bearerFormat: "Kubernetes ServiceAccount token",
        },
      },
    },
    securityRequirements: [
      { schemes: { projectedServiceAccountBearer: [] } },
    ],
    defaultInputModes: [ReferenceMediaType],
    defaultOutputModes: [ReferenceMediaType],
    skills,
  });
});

export const compileA2aPublicAgentCard = Effect.fn(
  "agentos.a2a.compilePublicAgentCard",
)(function*(input: unknown) {
  const card = yield* decodeContract(A2aPublicAgentCardInputV1, input);
  return yield* decodeContract(A2aAgentCardV1Schema, {
    name: card.targetHandle,
    description: card.description,
    supportedInterfaces: [{
      url: `${card.baseUrl}/agents/${card.targetAgentId}/a2a/jsonrpc`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }],
    version: card.agentVersion,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true,
    },
    securitySchemes: {
      projectedServiceAccountBearer: {
        httpAuthSecurityScheme: {
          description: "Kubelet-rotated projected Agent ServiceAccount identity",
          scheme: "Bearer",
          bearerFormat: "Kubernetes ServiceAccount token",
        },
      },
    },
    securityRequirements: [
      { schemes: { projectedServiceAccountBearer: [] } },
    ],
    defaultInputModes: [ReferenceMediaType],
    defaultOutputModes: [ReferenceMediaType],
    skills: [],
  });
});

export const evaluateA2aHierarchyRoute = Effect.fn(
  "agentos.a2a.evaluateHierarchyRoute",
)(function*(input: unknown) {
  const route = yield* decodeContract(A2aHierarchyRouteInputV1, input);
  switch (route.relationship.kind) {
    case "direct_parent_child":
      return {
        version: 1,
        decision: "deliver_direct",
        nextHopAgentId: route.targetAgentId,
      };
    case "cross_domain":
      return {
        version: 1,
        decision: "return_to_common_ancestor",
        nextHopAgentId: route.relationship.commonAncestorAgentId,
      };
    case "lateral":
      return yield* contractError(
        "hierarchy_edge_denied",
        "Lateral sibling and Crewmate A2A delivery is forbidden",
      );
  }
});

export const interpretA2aTransportResult = Effect.fn(
  "agentos.a2a.interpretTransportResult",
)(function*(input: unknown) {
  const result = yield* decodeContract(A2aTransportResultInputV1, input);
  return {
    version: 1,
    inboxId: result.inboxId,
    transport: result.transport,
    canonicalInbox: result.canonicalInbox,
    canonicalAssignment: result.canonicalAssignment,
    canonicalMutations: [],
    recovery: result.canonicalInbox === "unread"
      ? "postgres_listener_then_herdr_wake"
      : "not_required",
  };
});

export const planA2aRetry = Effect.fn(
  "agentos.a2a.planRetry",
)(function*(input: unknown) {
  const retry = yield* decodeContract(A2aRetryInputV1, input);
  return {
    version: 1,
    inboxId: retry.inboxId,
    action: retry.canonicalInbox === "unread"
      ? "wake_existing_reference"
      : "acknowledge_existing_delivery",
    mayCreate: {
      task: false,
      assignment: false,
      inbox: false,
      execution: false,
      durableReport: false,
    },
  };
});

export const evaluateA2aOutageRecovery = Effect.fn(
  "agentos.a2a.evaluateOutageRecovery",
)(function*(input: unknown) {
  const outage = yield* decodeContract(A2aOutageRecoveryInputV1, input);
  if (outage.canonicalStatus !== "committed") {
    return yield* contractError(
      "canonical_row_not_committed",
      "Outage recovery cannot claim work that did not commit before A2A delivery",
    );
  }
  return {
    version: 1,
    inboxId: outage.inboxId,
    failure: outage.failure,
    committedWork: "unchanged",
    discovery: "postgresql_listener",
    wake: "herdr_after_recovery",
    a2aReplay: "same_inbox_reference_only",
  };
});

function decodeContract<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], A2aContractError, S["DecodingServices"]> {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.mapError(() =>
      contractError(
        "invalid_contract",
        "A2A input must match the closed AgentOS v1 contract",
      ),
    ),
  );
}

function contractError(
  code: A2aContractError["code"],
  message: string,
) {
  return A2aContractError.make({ code, message });
}
