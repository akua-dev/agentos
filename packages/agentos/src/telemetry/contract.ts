import { Schema } from "effect";

import { ASSIGNMENT_EXECUTION_FAILURE_CLASSES } from "../supervision/retry-recovery.ts";
import {
  SECOND_MATE_TOPOLOGY_ACTIONS,
  SECOND_MATE_TOPOLOGY_REASONS,
} from "../topology/second-mate.ts";
import { AGENT_WORKLOAD_PROFILE_IDS } from "../workloads/profiles.ts";

const values = <const Values extends ReadonlyArray<string | number>>(
  ...entries: Values
) => entries;

const constant = <const Value extends Readonly<Record<string, string>>>(
  value: Value,
) => Object.freeze(value);

export const AGENTOS_TELEMETRY_CONTRACT_VERSION = 1;
export const AGENTOS_AI_TELEMETRY_CONTRACT_VERSION =
  AGENTOS_TELEMETRY_CONTRACT_VERSION;

export const AGENTOS_TELEMETRY_DOMAINS = values(
  "runtime",
  "ai",
  "compaction",
  "memory",
  "access",
  "protocol",
  "topology",
  "readiness",
  "recovery",
  "telemetry_pipeline",
);
export type AgentOSTelemetryDomain =
  (typeof AGENTOS_TELEMETRY_DOMAINS)[number];

export const AGENTOS_TELEMETRY_SIGNALS = values(
  "resource",
  "span",
  "metric",
  "log",
  "audit",
);
export type AgentOSTelemetryContractSignal =
  (typeof AGENTOS_TELEMETRY_SIGNALS)[number];

export const AGENTOS_TELEMETRY_SPANS = Object.freeze({
  accessAgentGateway: "agentos.access.agentgateway",
  accessAuthorization: "agentos.access.authorization",
  accessCredentialRelease: "agentos.access.credential.release",
  accessHttp: "agentos.access.http",
  accessMcp: "agentos.access.mcp",
  accessProvider: "agentos.access.provider",
  accessProviderAdapter: "agentos.access.provider_adapter",
  aiGatewayAuthenticate: "ai-gateway.authenticate",
  aiGatewayQuotaRefresh: "ai-gateway.quota.refresh",
  aiGatewayRequest: "ai-gateway.request",
  aiGatewayRouteAcquire: "ai-gateway.route.acquire",
  aiGatewayRouteRelease: "ai-gateway.route.release",
  aiGatewayStream: "ai-gateway.stream",
  aiGatewayUpstream: "ai-gateway.upstream",
  aiOperation: "agentos.ai.operation",
  aiProviderAttempt: "agentos.ai.provider.attempt",
  compactionOperation: "agentos.compaction.operation",
  memoryOperation: "agentos.memory.operation",
  protocolOperation: "agentos.protocol.operation",
  readinessCheck: "agentos.readiness.check",
  resilienceApply: "agentos.resilience.apply",
  resilienceCapacity: "agentos.resilience.capacity",
  resilienceListener: "agentos.resilience.listener",
  resilienceOperation: "agentos.resilience.operation",
  resilienceOutcome: "agentos.resilience.outcome",
  resiliencePlacement: "agentos.resilience.placement",
  resilienceProtocol: "agentos.resilience.protocol",
  resilienceProvider: "agentos.resilience.provider",
  resilienceReadiness: "agentos.resilience.readiness",
  resilienceReconciliation: "agentos.resilience.reconciliation",
  resilienceRender: "agentos.resilience.render",
  resilienceSession: "agentos.resilience.session",
  resilienceTopologyDecision: "agentos.resilience.topology_decision",
  resilienceWorkloadPlan: "agentos.resilience.workload_plan",
  telemetryPipeline: "agentos.telemetry.pipeline",
  topologyDecision: "agentos.topology.decision",
});

export const AGENTOS_TELEMETRY_EVENTS = constant({
  accessCredentialRelease: "agentos.access.credential.release",
  accessDecision: "agentos.access.decision",
  aiGatewayFailure: "ai_gateway_failure",
  compactionFailure: "agentos.compaction.failure",
  memoryDegraded: "agentos.memory.degraded",
  memoryForgotten: "agentos.memory.forgotten",
  protocolFallback: "agentos.protocol.fallback",
  readinessTransition: "agentos.readiness.transition",
  resilienceObservation: "agentos.resilience.observation",
  telemetryExportFailure: "agentos.telemetry.export.failure",
  topologyDecision: "agentos.topology.decision",
});

export const AGENTOS_RESILIENCE_SOURCES = values(
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
export const AGENTOS_RESILIENCE_PHASES = values(
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
export const AGENTOS_RESILIENCE_CAUSES = values(
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
export const AGENTOS_RESILIENCE_EVIDENCE = values("observed", "unobserved");
export const AGENTOS_RESILIENCE_FAILURE_CLASSES =
  ASSIGNMENT_EXECUTION_FAILURE_CLASSES;
export const AGENTOS_RESILIENCE_OUTCOMES = values(
  "pending",
  "succeeded",
  "degraded",
  "recovered",
  "failed",
  "blocked",
  "unobserved",
);
export const AGENTOS_RESILIENCE_RECOVERY_CLASSES = values(
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
export const AGENTOS_RESILIENCE_RUNTIME_ACTIONS = values(
  "provision",
  "rollout",
  "recover",
  "teardown",
);
export const AGENTOS_RESILIENCE_JOURNAL_PHASES = values(
  "prepared",
  "applied",
  "workload_ready",
  "harness_ready",
  "recovery_required",
  "completed",
  "failed",
  "superseded",
);
export const AGENTOS_RESILIENCE_PROTOCOLS = values("acp", "a2a");

export const AGENTOS_AI_RUNTIMES = values("pi", "codex");
export type AgentOSAIRuntime = (typeof AGENTOS_AI_RUNTIMES)[number];

export const AGENTOS_AI_ROUTES = values("direct", "ai_gateway");
export type AgentOSAIRoute = (typeof AGENTOS_AI_ROUTES)[number];

export const AGENTOS_AI_ROUTE_OPERATIONS = values(
  "acquire",
  "reserve",
  "block",
  "release",
);
export type AgentOSAIRouteOperation =
  (typeof AGENTOS_AI_ROUTE_OPERATIONS)[number];

export const AGENTOS_AI_QUOTA_OUTCOMES = values(
  "cache_hit",
  "fresh",
  "stale",
  "failed",
);
export type AgentOSAIQuotaOutcome =
  (typeof AGENTOS_AI_QUOTA_OUTCOMES)[number];

export const AGENTOS_AI_REQUEST_KINDS = values(
  "main",
  "compaction",
  "memory_extract",
  "memory_consolidate",
  "extension",
);
export type AgentOSAIRequestKind = (typeof AGENTOS_AI_REQUEST_KINDS)[number];

export const AGENTOS_AI_COMPACTION_PATHS = values(
  "portable_summary",
  "native_server",
);
export type AgentOSAICompactionPath =
  (typeof AGENTOS_AI_COMPACTION_PATHS)[number];

export const AGENTOS_AI_STATUS_CLASSES = values(
  "success",
  "client_error",
  "server_error",
  "cancelled",
  "error",
);
export type AgentOSAIStatusClass =
  (typeof AGENTOS_AI_STATUS_CLASSES)[number];

export const AGENTOS_AI_ERROR_CLASSES = values(
  "none",
  "authentication",
  "rate_limit",
  "overload",
  "timeout",
  "abort",
  "transport",
  "protocol",
  "decode",
  "unavailable",
  "unknown",
);
export type AgentOSAIErrorClass =
  (typeof AGENTOS_AI_ERROR_CLASSES)[number];

export const AGENTOS_AI_STREAM_OUTCOMES = values(
  "not_streamed",
  "completed",
  "client_disconnect",
  "aborted",
  "upstream_error",
);
export type AgentOSAIStreamOutcome =
  (typeof AGENTOS_AI_STREAM_OUTCOMES)[number];

export const AGENTOS_AI_MODEL_FAMILIES = values(
  "gpt-5",
  "gpt-4.1",
  "o-series",
  "other",
);
export type AgentOSAIModelFamily =
  (typeof AGENTOS_AI_MODEL_FAMILIES)[number];

export const AGENTOS_AI_PROVIDER_FAMILIES = values("openai", "other");
export type AgentOSAIProviderFamily =
  (typeof AGENTOS_AI_PROVIDER_FAMILIES)[number];

export const AGENTOS_AI_SESSION_STATES = values("fresh", "resumed");
export type AgentOSAISessionState =
  (typeof AGENTOS_AI_SESSION_STATES)[number];

export const AGENTOS_AI_STREAM_MODES = values(
  "streaming",
  "non_streaming",
);
export type AgentOSAIStreamMode =
  (typeof AGENTOS_AI_STREAM_MODES)[number];

export const AGENTOS_AI_METRICS = constant({
  operations: "agentos.ai.operations",
  providerAttempts: "agentos.ai.provider.attempts",
  operationDuration: "agentos.ai.operation.duration",
  providerDuration: "agentos.ai.provider.duration",
  upstreamHeadersDuration: "agentos.ai.upstream.headers.duration",
  firstByteDuration: "agentos.ai.stream.first_byte.duration",
  streamDuration: "agentos.ai.stream.duration",
  activeStreams: "agentos.ai.streams.active",
  streamChunks: "agentos.ai.stream.chunks",
  streamBytes: "agentos.ai.stream.bytes",
  streams: "agentos.ai.streams",
  routeAcquisitionDuration: "agentos.ai.route.acquire.duration",
  routeEvents: "agentos.ai.route.events",
  activeReservations: "agentos.ai.route.reservations.active",
  quotaObservationAge: "agentos.ai.quota.observation.age",
  quotaRefreshes: "agentos.ai.quota.refreshes",
  tokens: "agentos.ai.tokens",
  cost: "agentos.ai.cost",
  budgetEvents: "agentos.ai.budget.events",
});

export const AGENTOS_MEMORY_METRICS = constant({
  operations: "agentos.memory.operations",
  operationDuration: "agentos.memory.operation.duration",
  candidates: "agentos.memory.candidates",
  attachments: "agentos.memory.attachments",
  attachedBytes: "agentos.memory.attached.bytes",
  indexAge: "agentos.memory.index.age",
});

export const AGENTOS_ACCESS_METRICS = constant({
  decisions: "agentos.access.decisions",
  decisionDuration: "agentos.access.decision.duration",
  revocationDuration: "agentos.access.revocation.duration",
  profileReloadDuration: "agentos.access.profile_reload.duration",
  credentialReleases: "agentos.access.credential.releases",
  protocolOperations: "agentos.access.protocol.operations",
});

export const AGENTOS_PROTOCOL_METRICS = constant({
  operations: "agentos.protocol.operations",
  operationDuration: "agentos.protocol.operation.duration",
  fallbacks: "agentos.protocol.fallbacks",
});

export const AGENTOS_RESILIENCE_METRIC_NAMES = constant({
  observations: "agentos.resilience.observations",
  operations: "agentos.resilience.operations",
  operationDuration: "agentos.resilience.operation.duration",
  topologyDecisions: "agentos.topology.decisions",
  readinessChecks: "agentos.readiness.checks",
});

export const AGENTOS_TELEMETRY_PIPELINE_METRICS = constant({
  events: "agentos.telemetry.pipeline.events",
  queueSize: "agentos.telemetry.queue.size",
  exportDuration: "agentos.telemetry.export.duration",
  droppedBatches: "agentos.telemetry.dropped.batches",
});

export const AGENTOS_AI_DURATION_BUCKETS_SECONDS = Object.freeze(values(
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
  120,
  300,
));

export const AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS = 86_400;

const TelemetryNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(3),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/),
  ),
);
const NonNegativeNumberSchema = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const AttributeValueRuleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("enum"),
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("number"),
    minimum: Schema.NullOr(Schema.Number),
    maximum: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("boolean") }),
  Schema.Struct({
    kind: Schema.Literal("opaque"),
    format: Schema.Literals([
      "decision_ref",
      "digest",
      "identifier",
      "profile_id",
      "provider_request",
      "resource_name",
      "route_slot",
      "uuid",
      "version",
    ]),
    maximumLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(256),
      ),
    ),
  }),
]);

export class AgentOSTelemetryAttributeDefinitionV1Schema extends Schema.Class<AgentOSTelemetryAttributeDefinitionV1Schema>(
  "AgentOSTelemetryAttributeDefinitionV1",
)({
  name: TelemetryNameSchema,
  owner: Schema.Literals(AGENTOS_TELEMETRY_DOMAINS),
  source: Schema.Literals([
    "agentos_instrumentation",
    "collector",
    "database",
    "kubernetes",
    "provider",
    "runtime",
  ]),
  signals: Schema.Array(Schema.Literals(AGENTOS_TELEMETRY_SIGNALS)),
  sensitivity: Schema.Literals([
    "public_operational",
    "operational",
    "restricted",
  ]),
  cardinality: Schema.Literals(["low", "bounded", "unbounded"]),
  value: AttributeValueRuleSchema,
}) {}

export class AgentOSTelemetryMetricDefinitionV1Schema extends Schema.Class<AgentOSTelemetryMetricDefinitionV1Schema>(
  "AgentOSTelemetryMetricDefinitionV1",
)({
  name: TelemetryNameSchema,
  owner: Schema.Literals(AGENTOS_TELEMETRY_DOMAINS),
  instrument: Schema.Literals(["counter", "up_down_counter", "histogram"]),
  unit: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
  labels: Schema.Array(TelemetryNameSchema),
  histogramBoundaries: Schema.Array(NonNegativeNumberSchema),
  valueSemantics: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(96),
      Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
    ),
  ),
}) {}

export class AgentOSTelemetryEventDefinitionV1Schema extends Schema.Class<AgentOSTelemetryEventDefinitionV1Schema>(
  "AgentOSTelemetryEventDefinitionV1",
)({
  name: TelemetryNameSchema,
  owner: Schema.Literals(AGENTOS_TELEMETRY_DOMAINS),
  signal: Schema.Literals(["log", "audit"]),
  attributes: Schema.Array(TelemetryNameSchema),
  valueSemantics: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(96),
      Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
    ),
  ),
}) {}

type AttributeDefinition =
  typeof AgentOSTelemetryAttributeDefinitionV1Schema.Type;
type AttributeValueRule = AttributeDefinition["value"];
type MetricDefinition = typeof AgentOSTelemetryMetricDefinitionV1Schema.Type;
type EventDefinition = typeof AgentOSTelemetryEventDefinitionV1Schema.Type;

const allOperationalSignals: ReadonlyArray<AgentOSTelemetryContractSignal> = [
  "span",
  "metric",
  "log",
  "audit",
];
const correlatedSignals: ReadonlyArray<AgentOSTelemetryContractSignal> = [
  "span",
  "log",
  "audit",
];
const resourceSignals: ReadonlyArray<AgentOSTelemetryContractSignal> = [
  "resource",
];
const resourceAndOperationalSignals: ReadonlyArray<
  AgentOSTelemetryContractSignal
> = ["resource", ...allOperationalSignals];
const resourceCorrelatedSignals: ReadonlyArray<
  AgentOSTelemetryContractSignal
> = ["resource", ...correlatedSignals];
const spanLogSignals: ReadonlyArray<AgentOSTelemetryContractSignal> = [
  "span",
  "log",
];

function attributeDefinition(
  name: string,
  owner: AttributeDefinition["owner"],
  source: AttributeDefinition["source"],
  signals: ReadonlyArray<AgentOSTelemetryContractSignal>,
  sensitivity: AttributeDefinition["sensitivity"],
  cardinality: AttributeDefinition["cardinality"],
  value: AttributeValueRule,
): AttributeDefinition {
  return Object.freeze({
    name,
    owner,
    source,
    signals,
    sensitivity,
    cardinality,
    value,
  });
}

function boundedEnum(
  name: string,
  owner: AttributeDefinition["owner"],
  values_: ReadonlyArray<string>,
  source: AttributeDefinition["source"] = "agentos_instrumentation",
  signals: ReadonlyArray<AgentOSTelemetryContractSignal> =
    allOperationalSignals,
) {
  return attributeDefinition(
    name,
    owner,
    source,
    signals,
    "public_operational",
    "bounded",
    { kind: "enum", values: values_ },
  );
}

function boundedNumber(
  name: string,
  owner: AttributeDefinition["owner"],
  minimum: number | null,
  maximum: number | null,
  signals: ReadonlyArray<AgentOSTelemetryContractSignal> = spanLogSignals,
) {
  return attributeDefinition(
    name,
    owner,
    "agentos_instrumentation",
    signals,
    "operational",
    "bounded",
    { kind: "number", minimum, maximum },
  );
}

function boundedBoolean(
  name: string,
  owner: AttributeDefinition["owner"],
) {
  return attributeDefinition(
    name,
    owner,
    "agentos_instrumentation",
    allOperationalSignals,
    "operational",
    "low",
    { kind: "boolean" },
  );
}

function protectedOpaque(
  name: string,
  owner: AttributeDefinition["owner"],
  format: Extract<AttributeValueRule, { readonly kind: "opaque" }>["format"],
  maximumLength: number,
  source: AttributeDefinition["source"] = "agentos_instrumentation",
) {
  return attributeDefinition(
    name,
    owner,
    source,
    correlatedSignals,
    "restricted",
    "unbounded",
    { kind: "opaque", format, maximumLength },
  );
}

function boundedOpaque(
  name: string,
  owner: AttributeDefinition["owner"],
  format: Extract<AttributeValueRule, { readonly kind: "opaque" }>["format"],
  maximumLength: number,
  source: AttributeDefinition["source"] = "agentos_instrumentation",
  signals: ReadonlyArray<AgentOSTelemetryContractSignal> = correlatedSignals,
) {
  return attributeDefinition(
    name,
    owner,
    source,
    signals,
    "operational",
    "bounded",
    { kind: "opaque", format, maximumLength },
  );
}

function resourceAttribute(
  name: string,
  owner: AttributeDefinition["owner"],
) {
  return attributeDefinition(
    name,
    owner,
    "kubernetes",
    resourceSignals,
    "operational",
    "bounded",
    { kind: "opaque", format: "resource_name", maximumLength: 128 },
  );
}

export const AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS: Readonly<
  Record<string, AttributeDefinition>
> = Object.freeze({
  "agentos.telemetry.contract.version": boundedNumber(
    "agentos.telemetry.contract.version",
    "runtime",
    1,
    1,
    resourceAndOperationalSignals,
  ),
  "service.name": resourceAttribute("service.name", "runtime"),
  "service.namespace": resourceAttribute("service.namespace", "runtime"),
  "service.version": resourceAttribute("service.version", "runtime"),
  "deployment.environment.name": resourceAttribute(
    "deployment.environment.name",
    "runtime",
  ),
  "k8s.cluster.name": resourceAttribute("k8s.cluster.name", "runtime"),
  "k8s.namespace.name": resourceAttribute("k8s.namespace.name", "runtime"),
  "k8s.workload.name": resourceAttribute("k8s.workload.name", "runtime"),
  "k8s.pod.name": resourceAttribute("k8s.pod.name", "runtime"),
  "k8s.container.name": resourceAttribute("k8s.container.name", "runtime"),
  "agentos.fleet.name": resourceAttribute("agentos.fleet.name", "runtime"),
  "agentos.ai.runtime": boundedEnum(
    "agentos.ai.runtime",
    "ai",
    AGENTOS_AI_RUNTIMES,
    "runtime",
    resourceAndOperationalSignals,
  ),
  "agentos.ai.runtime.version": boundedOpaque(
    "agentos.ai.runtime.version",
    "runtime",
    "version",
    32,
    "runtime",
    resourceCorrelatedSignals,
  ),
  "agentos.ai.route": boundedEnum(
    "agentos.ai.route",
    "ai",
    AGENTOS_AI_ROUTES,
  ),
  "agentos.ai.route.operation": boundedEnum(
    "agentos.ai.route.operation",
    "ai",
    AGENTOS_AI_ROUTE_OPERATIONS,
  ),
  "agentos.ai.provider.family": boundedEnum(
    "agentos.ai.provider.family",
    "ai",
    AGENTOS_AI_PROVIDER_FAMILIES,
  ),
  "agentos.ai.request.kind": boundedEnum(
    "agentos.ai.request.kind",
    "ai",
    AGENTOS_AI_REQUEST_KINDS,
  ),
  "agentos.ai.compaction.path": boundedEnum(
    "agentos.ai.compaction.path",
    "compaction",
    AGENTOS_AI_COMPACTION_PATHS,
  ),
  "agentos.ai.status_class": boundedEnum(
    "agentos.ai.status_class",
    "ai",
    AGENTOS_AI_STATUS_CLASSES,
  ),
  "agentos.ai.error.class": boundedEnum(
    "agentos.ai.error.class",
    "ai",
    AGENTOS_AI_ERROR_CLASSES,
  ),
  "agentos.ai.stream.mode": boundedEnum(
    "agentos.ai.stream.mode",
    "ai",
    AGENTOS_AI_STREAM_MODES,
  ),
  "agentos.ai.stream.outcome": boundedEnum(
    "agentos.ai.stream.outcome",
    "ai",
    AGENTOS_AI_STREAM_OUTCOMES,
  ),
  "agentos.ai.session.state": boundedEnum(
    "agentos.ai.session.state",
    "ai",
    AGENTOS_AI_SESSION_STATES,
  ),
  "agentos.ai.model.family": boundedEnum(
    "agentos.ai.model.family",
    "ai",
    AGENTOS_AI_MODEL_FAMILIES,
  ),
  "agentos.ai.token.type": boundedEnum(
    "agentos.ai.token.type",
    "ai",
    ["input", "output", "cache_read", "cache_write"],
  ),
  "agentos.ai.cost.source": boundedEnum(
    "agentos.ai.cost.source",
    "ai",
    ["modeled_catalog", "provider_reported"],
  ),
  "agentos.ai.budget.state": boundedEnum(
    "agentos.ai.budget.state",
    "access",
    ["available", "warning", "exhausted", "killed"],
  ),
  "agentos.ai.quota.stale": boundedBoolean("agentos.ai.quota.stale", "ai"),
  "agentos.ai.quota.outcome": boundedEnum(
    "agentos.ai.quota.outcome",
    "ai",
    AGENTOS_AI_QUOTA_OUTCOMES,
  ),
  "agentos.ai.retry.count": boundedNumber(
    "agentos.ai.retry.count",
    "ai",
    0,
    32,
    allOperationalSignals,
  ),
  "agentos.ai.stream.chunks": boundedNumber(
    "agentos.ai.stream.chunks",
    "ai",
    0,
    null,
  ),
  "agentos.ai.stream.bytes": boundedNumber(
    "agentos.ai.stream.bytes",
    "ai",
    0,
    null,
  ),
  "agentos.ai.usage.input_tokens": boundedNumber(
    "agentos.ai.usage.input_tokens",
    "ai",
    0,
    null,
  ),
  "agentos.ai.usage.output_tokens": boundedNumber(
    "agentos.ai.usage.output_tokens",
    "ai",
    0,
    null,
  ),
  "http.response.status_code": boundedNumber(
    "http.response.status_code",
    "access",
    100,
    599,
  ),
  "agentos.memory.operation": boundedEnum(
    "agentos.memory.operation",
    "memory",
    ["extract", "consolidate", "retrieve", "rebuild", "pause", "forget"],
  ),
  "agentos.memory.method": boundedEnum(
    "agentos.memory.method",
    "memory",
    ["selector", "lexical", "vector", "hybrid", "fallback"],
  ),
  "agentos.memory.outcome": boundedEnum(
    "agentos.memory.outcome",
    "memory",
    ["succeeded", "degraded", "failed", "unobserved"],
  ),
  "agentos.memory.degradation.class": boundedEnum(
    "agentos.memory.degradation.class",
    "memory",
    [
      "none",
      "index_unavailable",
      "index_stale",
      "index_corrupt",
      "resource_limit",
      "paused",
      "fallback",
      "unobserved",
    ],
  ),
  "agentos.memory.index.state": boundedEnum(
    "agentos.memory.index.state",
    "memory",
    ["absent", "ready", "stale", "rebuilding", "corrupt", "paused"],
  ),
  "agentos.access.operation": boundedEnum(
    "agentos.access.operation",
    "access",
    [
      "identity",
      "token_review",
      "authorization",
      "credential",
      "http",
      "mcp",
      "revocation",
      "profile_reload",
    ],
  ),
  "agentos.access.decision": boundedEnum(
    "agentos.access.decision",
    "access",
    ["allow", "deny", "error", "unobserved"],
  ),
  "agentos.access.reason": boundedEnum(
    "agentos.access.reason",
    "access",
    [
      "allowed",
      "identity_invalid",
      "assignment_inactive",
      "profile_denied",
      "ceiling_denied",
      "budget_denied",
      "dependency_unavailable",
      "rate_limited",
      "revoked",
      "unknown",
    ],
  ),
  "agentos.access.dependency": boundedEnum(
    "agentos.access.dependency",
    "access",
    [
      "none",
      "kubernetes",
      "postgresql",
      "openfga",
      "agentgateway",
      "credential_adapter",
      "provider",
    ],
  ),
  "agentos.access.cache.result": boundedEnum(
    "agentos.access.cache.result",
    "access",
    ["hit", "miss", "bypass", "invalidated"],
  ),
  "agentos.access.credential.outcome": boundedEnum(
    "agentos.access.credential.outcome",
    "access",
    ["not_requested", "released", "withheld", "failed"],
  ),
  "agentos.authz.rate_class": attributeDefinition(
    "agentos.authz.rate_class",
    "access",
    "agentos_instrumentation",
    correlatedSignals,
    "operational",
    "bounded",
    { kind: "enum", values: ["low", "standard", "high"] },
  ),
  "agentos.protocol.name": boundedEnum(
    "agentos.protocol.name",
    "protocol",
    ["http", "mcp", "acp", "a2a"],
  ),
  "agentos.protocol.operation": boundedEnum(
    "agentos.protocol.operation",
    "protocol",
    [
      "discover",
      "invoke",
      "stream",
      "cancel",
      "artifact",
      "create",
      "load",
      "prompt",
      "permission",
      "resume",
    ],
  ),
  "agentos.protocol.outcome": boundedEnum(
    "agentos.protocol.outcome",
    "protocol",
    ["succeeded", "denied", "cancelled", "degraded", "failed", "unobserved"],
  ),
  "agentos.protocol.fallback": boundedEnum(
    "agentos.protocol.fallback",
    "protocol",
    ["none", "postgresql_listener", "herdr", "native_session", "unobserved"],
  ),
  "agentos.topology.action": boundedEnum(
    "agentos.topology.action",
    "topology",
    SECOND_MATE_TOPOLOGY_ACTIONS,
  ),
  "agentos.topology.reason": boundedEnum(
    "agentos.topology.reason",
    "topology",
    SECOND_MATE_TOPOLOGY_REASONS,
  ),
  "agentos.readiness.component": boundedEnum(
    "agentos.readiness.component",
    "readiness",
    [
      "runtime",
      "provider",
      "session",
      "listener",
      "identity",
      "authorization",
      "gateway",
      "memory",
      "telemetry",
    ],
  ),
  "agentos.readiness.outcome": boundedEnum(
    "agentos.readiness.outcome",
    "readiness",
    ["ready", "degraded", "not_ready", "unobserved"],
  ),
  "agentos.resilience.source": boundedEnum(
    "agentos.resilience.source",
    "recovery",
    AGENTOS_RESILIENCE_SOURCES,
  ),
  "agentos.resilience.phase": boundedEnum(
    "agentos.resilience.phase",
    "recovery",
    AGENTOS_RESILIENCE_PHASES,
  ),
  "agentos.resilience.evidence": boundedEnum(
    "agentos.resilience.evidence",
    "recovery",
    AGENTOS_RESILIENCE_EVIDENCE,
  ),
  "agentos.resilience.outcome": boundedEnum(
    "agentos.resilience.outcome",
    "recovery",
    AGENTOS_RESILIENCE_OUTCOMES,
  ),
  "agentos.resilience.cause": boundedEnum(
    "agentos.resilience.cause",
    "recovery",
    AGENTOS_RESILIENCE_CAUSES,
  ),
  "agentos.resilience.recovery": boundedEnum(
    "agentos.resilience.recovery",
    "recovery",
    AGENTOS_RESILIENCE_RECOVERY_CLASSES,
  ),
  "agentos.resilience.failure.class": boundedEnum(
    "agentos.resilience.failure.class",
    "recovery",
    AGENTOS_RESILIENCE_FAILURE_CLASSES,
  ),
  "agentos.resilience.attempt": boundedNumber(
    "agentos.resilience.attempt",
    "recovery",
    0,
    32,
    allOperationalSignals,
  ),
  "agentos.resilience.topology.action": boundedEnum(
    "agentos.resilience.topology.action",
    "topology",
    SECOND_MATE_TOPOLOGY_ACTIONS,
  ),
  "agentos.resilience.topology.reason": boundedEnum(
    "agentos.resilience.topology.reason",
    "topology",
    SECOND_MATE_TOPOLOGY_REASONS,
  ),
  "agentos.resilience.runtime.action": boundedEnum(
    "agentos.resilience.runtime.action",
    "runtime",
    AGENTOS_RESILIENCE_RUNTIME_ACTIONS,
  ),
  "agentos.resilience.workload.profile": boundedEnum(
    "agentos.resilience.workload.profile",
    "runtime",
    AGENT_WORKLOAD_PROFILE_IDS,
  ),
  "agentos.resilience.workload.spec_version": boundedNumber(
    "agentos.resilience.workload.spec_version",
    "runtime",
    1,
    null,
    allOperationalSignals,
  ),
  "agentos.resilience.journal.phase": boundedEnum(
    "agentos.resilience.journal.phase",
    "recovery",
    AGENTOS_RESILIENCE_JOURNAL_PHASES,
  ),
  "agentos.resilience.protocol": boundedEnum(
    "agentos.resilience.protocol",
    "protocol",
    AGENTOS_RESILIENCE_PROTOCOLS,
  ),
  "agentos.telemetry.signal": boundedEnum(
    "agentos.telemetry.signal",
    "telemetry_pipeline",
    ["traces", "metrics", "logs", "audit"],
    "collector",
  ),
  "agentos.telemetry.stage": boundedEnum(
    "agentos.telemetry.stage",
    "telemetry_pipeline",
    ["received", "queued", "exported", "dropped", "unavailable"],
    "collector",
  ),
  "agentos.telemetry.outcome": boundedEnum(
    "agentos.telemetry.outcome",
    "telemetry_pipeline",
    ["succeeded", "retrying", "failed", "evicted", "unobserved"],
    "collector",
  ),
  "agentos.telemetry.reason": boundedEnum(
    "agentos.telemetry.reason",
    "telemetry_pipeline",
    [
      "none",
      "exporter_unavailable",
      "queue_full",
      "storage_unavailable",
      "privacy_rejected",
      "invalid_context",
      "shutdown",
      "unknown",
    ],
    "collector",
  ),
  "agentos.ai.route.slot": protectedOpaque(
    "agentos.ai.route.slot",
    "ai",
    "route_slot",
    32,
  ),
  "agentos.ai.operation.id": protectedOpaque(
    "agentos.ai.operation.id",
    "ai",
    "identifier",
    128,
  ),
  "agentos.ai.request.attempt_id": protectedOpaque(
    "agentos.ai.request.attempt_id",
    "ai",
    "identifier",
    128,
  ),
  "agentos.ai.provider.request_id": protectedOpaque(
    "agentos.ai.provider.request_id",
    "ai",
    "provider_request",
    128,
    "provider",
  ),
  "agentos.identity.agent_id": protectedOpaque(
    "agentos.identity.agent_id",
    "access",
    "uuid",
    36,
    "database",
  ),
  "agentos.identity.assignment_id": protectedOpaque(
    "agentos.identity.assignment_id",
    "access",
    "uuid",
    36,
    "database",
  ),
  "agentos.identity.task_id": protectedOpaque(
    "agentos.identity.task_id",
    "access",
    "uuid",
    36,
    "database",
  ),
  "agentos.runtime.session.id": protectedOpaque(
    "agentos.runtime.session.id",
    "runtime",
    "identifier",
    128,
    "runtime",
  ),
  "agentos.request.id": protectedOpaque(
    "agentos.request.id",
    "runtime",
    "identifier",
    128,
  ),
  "agentos.operation.id": protectedOpaque(
    "agentos.operation.id",
    "runtime",
    "uuid",
    36,
    "database",
  ),
  "agentos.trace.id": protectedOpaque(
    "agentos.trace.id",
    "runtime",
    "identifier",
    32,
  ),
  "agentos.authz.decision_ref": protectedOpaque(
    "agentos.authz.decision_ref",
    "access",
    "decision_ref",
    41,
  ),
  "agentos.authz.profile_id": protectedOpaque(
    "agentos.authz.profile_id",
    "access",
    "profile_id",
    63,
    "database",
  ),
  "agentos.authz.profile_version": attributeDefinition(
    "agentos.authz.profile_version",
    "access",
    "database",
    correlatedSignals,
    "restricted",
    "unbounded",
    { kind: "number", minimum: 1, maximum: null },
  ),
  "agentos.memory.topic_id": protectedOpaque(
    "agentos.memory.topic_id",
    "memory",
    "identifier",
    128,
  ),
  "agentos.memory.index.version": protectedOpaque(
    "agentos.memory.index.version",
    "memory",
    "version",
    64,
  ),
  "agentos.resilience.operation.id": protectedOpaque(
    "agentos.resilience.operation.id",
    "recovery",
    "uuid",
    36,
    "database",
  ),
  "agentos.resilience.topology.proposal_id": protectedOpaque(
    "agentos.resilience.topology.proposal_id",
    "topology",
    "uuid",
    36,
    "database",
  ),
  "agentos.resilience.pod.uid": protectedOpaque(
    "agentos.resilience.pod.uid",
    "runtime",
    "uuid",
    36,
    "kubernetes",
  ),
  "agentos.resilience.pvc.uid": protectedOpaque(
    "agentos.resilience.pvc.uid",
    "runtime",
    "uuid",
    36,
    "kubernetes",
  ),
  "agentos.resilience.session.id": protectedOpaque(
    "agentos.resilience.session.id",
    "runtime",
    "identifier",
    128,
    "runtime",
  ),
  "agentos.resilience.protocol.id": protectedOpaque(
    "agentos.resilience.protocol.id",
    "protocol",
    "identifier",
    128,
    "runtime",
  ),
  "agentos.resilience.workload.spec_digest": protectedOpaque(
    "agentos.resilience.workload.spec_digest",
    "recovery",
    "digest",
    64,
  ),
  "agentos.resilience.workload.overlay_digest": protectedOpaque(
    "agentos.resilience.workload.overlay_digest",
    "recovery",
    "digest",
    64,
  ),
  "agentos.resilience.workload.render_digest": protectedOpaque(
    "agentos.resilience.workload.render_digest",
    "recovery",
    "digest",
    64,
  ),
});

function eventDefinition(
  name: string,
  owner: EventDefinition["owner"],
  signal: EventDefinition["signal"],
  attributes: ReadonlyArray<string>,
  valueSemantics: string,
): EventDefinition {
  return Object.freeze({
    name,
    owner,
    signal,
    attributes,
    valueSemantics,
  });
}

export const AGENTOS_TELEMETRY_EVENT_DEFINITIONS: Readonly<
  Record<string, EventDefinition>
> = Object.freeze({
  [AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.aiGatewayFailure,
    "ai",
    "log",
    [
      "agentos.telemetry.contract.version",
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.status_class",
      "agentos.ai.error.class",
      "agentos.ai.stream.outcome",
      "agentos.ai.operation.id",
      "agentos.ai.request.attempt_id",
      "agentos.ai.provider.request_id",
    ],
    "bounded_gateway_failure",
  ),
  [AGENTOS_TELEMETRY_EVENTS.compactionFailure]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.compactionFailure,
    "compaction",
    "log",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.compaction.path",
      "agentos.ai.status_class",
      "agentos.ai.error.class",
      "agentos.ai.operation.id",
    ],
    "bounded_compaction_failure",
  ),
  [AGENTOS_TELEMETRY_EVENTS.memoryDegraded]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.memoryDegraded,
    "memory",
    "log",
    [
      "agentos.memory.operation",
      "agentos.memory.method",
      "agentos.memory.outcome",
      "agentos.memory.degradation.class",
      "agentos.memory.index.state",
      "agentos.memory.topic_id",
      "agentos.memory.index.version",
    ],
    "bounded_memory_degradation",
  ),
  [AGENTOS_TELEMETRY_EVENTS.memoryForgotten]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.memoryForgotten,
    "memory",
    "audit",
    [
      "agentos.memory.operation",
      "agentos.memory.outcome",
      "agentos.memory.topic_id",
      "agentos.identity.agent_id",
    ],
    "durable_memory_forget_projection",
  ),
  [AGENTOS_TELEMETRY_EVENTS.accessDecision]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.accessDecision,
    "access",
    "audit",
    [
      "agentos.access.operation",
      "agentos.access.decision",
      "agentos.access.reason",
      "agentos.access.dependency",
      "agentos.identity.agent_id",
      "agentos.identity.assignment_id",
      "agentos.authz.decision_ref",
      "agentos.authz.profile_id",
      "agentos.authz.profile_version",
    ],
    "durable_access_decision_projection",
  ),
  [AGENTOS_TELEMETRY_EVENTS.accessCredentialRelease]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.accessCredentialRelease,
    "access",
    "audit",
    [
      "agentos.access.decision",
      "agentos.access.credential.outcome",
      "agentos.identity.agent_id",
      "agentos.identity.assignment_id",
      "agentos.authz.decision_ref",
    ],
    "durable_credential_release_projection",
  ),
  [AGENTOS_TELEMETRY_EVENTS.protocolFallback]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.protocolFallback,
    "protocol",
    "log",
    [
      "agentos.protocol.name",
      "agentos.protocol.operation",
      "agentos.protocol.outcome",
      "agentos.protocol.fallback",
      "agentos.resilience.protocol.id",
    ],
    "bounded_protocol_fallback",
  ),
  [AGENTOS_TELEMETRY_EVENTS.topologyDecision]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.topologyDecision,
    "topology",
    "audit",
    [
      "agentos.topology.action",
      "agentos.topology.reason",
      "agentos.identity.agent_id",
      "agentos.resilience.topology.proposal_id",
    ],
    "durable_topology_decision_projection",
  ),
  [AGENTOS_TELEMETRY_EVENTS.readinessTransition]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.readinessTransition,
    "readiness",
    "log",
    [
      "agentos.readiness.component",
      "agentos.readiness.outcome",
      "agentos.identity.agent_id",
    ],
    "bounded_readiness_transition",
  ),
  [AGENTOS_TELEMETRY_EVENTS.resilienceObservation]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.resilienceObservation,
    "recovery",
    "log",
    [
      "agentos.resilience.source",
      "agentos.resilience.phase",
      "agentos.resilience.evidence",
      "agentos.resilience.outcome",
      "agentos.resilience.cause",
      "agentos.resilience.recovery",
      "agentos.resilience.operation.id",
      "agentos.identity.agent_id",
      "agentos.identity.assignment_id",
    ],
    "bounded_resilience_observation",
  ),
  [AGENTOS_TELEMETRY_EVENTS.telemetryExportFailure]: eventDefinition(
    AGENTOS_TELEMETRY_EVENTS.telemetryExportFailure,
    "telemetry_pipeline",
    "log",
    [
      "agentos.telemetry.signal",
      "agentos.telemetry.stage",
      "agentos.telemetry.outcome",
      "agentos.telemetry.reason",
    ],
    "bounded_telemetry_export_failure",
  ),
});

function metricDefinition(
  name: string,
  owner: MetricDefinition["owner"],
  instrument: MetricDefinition["instrument"],
  unit: string,
  labels: ReadonlyArray<string>,
  valueSemantics: string,
  histogramBoundaries: ReadonlyArray<number> = [],
): MetricDefinition {
  return Object.freeze({
    name,
    owner,
    instrument,
    unit,
    labels,
    histogramBoundaries,
    valueSemantics,
  });
}

const durationBuckets = AGENTOS_AI_DURATION_BUCKETS_SECONDS;
const countBuckets = values(1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024);
const byteBuckets = values(
  1_024,
  4_096,
  16_384,
  65_536,
  262_144,
  1_048_576,
  4_194_304,
);

export const AGENTOS_TELEMETRY_METRIC_DEFINITIONS: Readonly<
  Record<string, MetricDefinition>
> = Object.freeze({
  [AGENTOS_AI_METRICS.operations]: metricDefinition(
    AGENTOS_AI_METRICS.operations,
    "ai",
    "counter",
    "{operation}",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.model.family",
      "agentos.ai.status_class",
      "agentos.ai.error.class",
    ],
    "completed_operations",
  ),
  [AGENTOS_AI_METRICS.providerAttempts]: metricDefinition(
    AGENTOS_AI_METRICS.providerAttempts,
    "ai",
    "counter",
    "{attempt}",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.compaction.path",
      "agentos.ai.model.family",
      "agentos.ai.status_class",
      "agentos.ai.error.class",
    ],
    "completed_provider_attempts",
  ),
  [AGENTOS_AI_METRICS.operationDuration]: metricDefinition(
    AGENTOS_AI_METRICS.operationDuration,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.runtime", "agentos.ai.route", "agentos.ai.status_class"],
    "operation_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.providerDuration]: metricDefinition(
    AGENTOS_AI_METRICS.providerDuration,
    "ai",
    "histogram",
    "s",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.compaction.path",
      "agentos.ai.status_class",
    ],
    "provider_attempt_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.upstreamHeadersDuration]: metricDefinition(
    AGENTOS_AI_METRICS.upstreamHeadersDuration,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.route", "agentos.ai.status_class"],
    "request_to_upstream_headers_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.firstByteDuration]: metricDefinition(
    AGENTOS_AI_METRICS.firstByteDuration,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.route"],
    "request_to_first_response_byte_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.streamDuration]: metricDefinition(
    AGENTOS_AI_METRICS.streamDuration,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.route", "agentos.ai.stream.outcome"],
    "stream_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.activeStreams]: metricDefinition(
    AGENTOS_AI_METRICS.activeStreams,
    "ai",
    "up_down_counter",
    "{stream}",
    ["agentos.ai.route"],
    "currently_active_streams",
  ),
  [AGENTOS_AI_METRICS.streamChunks]: metricDefinition(
    AGENTOS_AI_METRICS.streamChunks,
    "ai",
    "counter",
    "{chunk}",
    ["agentos.ai.route", "agentos.ai.stream.outcome"],
    "completed_stream_chunks",
  ),
  [AGENTOS_AI_METRICS.streamBytes]: metricDefinition(
    AGENTOS_AI_METRICS.streamBytes,
    "ai",
    "counter",
    "By",
    ["agentos.ai.route", "agentos.ai.stream.outcome"],
    "completed_stream_bytes",
  ),
  [AGENTOS_AI_METRICS.streams]: metricDefinition(
    AGENTOS_AI_METRICS.streams,
    "ai",
    "counter",
    "{stream}",
    ["agentos.ai.route", "agentos.ai.stream.outcome"],
    "completed_streams",
  ),
  [AGENTOS_AI_METRICS.routeAcquisitionDuration]: metricDefinition(
    AGENTOS_AI_METRICS.routeAcquisitionDuration,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.route", "agentos.ai.status_class"],
    "route_reservation_duration",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.routeEvents]: metricDefinition(
    AGENTOS_AI_METRICS.routeEvents,
    "ai",
    "counter",
    "{event}",
    [
      "agentos.ai.route",
      "agentos.ai.route.operation",
      "agentos.ai.status_class",
      "agentos.ai.error.class",
    ],
    "completed_route_lifecycle_events",
  ),
  [AGENTOS_AI_METRICS.activeReservations]: metricDefinition(
    AGENTOS_AI_METRICS.activeReservations,
    "ai",
    "up_down_counter",
    "{reservation}",
    ["agentos.ai.route"],
    "currently_active_route_reservations",
  ),
  [AGENTOS_AI_METRICS.quotaObservationAge]: metricDefinition(
    AGENTOS_AI_METRICS.quotaObservationAge,
    "ai",
    "histogram",
    "s",
    ["agentos.ai.route", "agentos.ai.quota.stale"],
    "quota_observation_age",
    durationBuckets,
  ),
  [AGENTOS_AI_METRICS.quotaRefreshes]: metricDefinition(
    AGENTOS_AI_METRICS.quotaRefreshes,
    "ai",
    "counter",
    "{refresh}",
    [
      "agentos.ai.route",
      "agentos.ai.quota.outcome",
      "agentos.ai.error.class",
    ],
    "completed_quota_refresh_attempts",
  ),
  [AGENTOS_AI_METRICS.tokens]: metricDefinition(
    AGENTOS_AI_METRICS.tokens,
    "ai",
    "counter",
    "{token}",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.token.type",
    ],
    "provider_reported_or_normalized_tokens",
  ),
  [AGENTOS_AI_METRICS.cost]: metricDefinition(
    AGENTOS_AI_METRICS.cost,
    "ai",
    "counter",
    "{USD}",
    [
      "agentos.ai.runtime",
      "agentos.ai.route",
      "agentos.ai.request.kind",
      "agentos.ai.cost.source",
    ],
    "modeled_catalog_cost_not_invoice_truth",
  ),
  [AGENTOS_AI_METRICS.budgetEvents]: metricDefinition(
    AGENTOS_AI_METRICS.budgetEvents,
    "access",
    "counter",
    "{event}",
    ["agentos.ai.route", "agentos.ai.budget.state"],
    "budget_state_transitions",
  ),
  [AGENTOS_MEMORY_METRICS.operations]: metricDefinition(
    AGENTOS_MEMORY_METRICS.operations,
    "memory",
    "counter",
    "{operation}",
    [
      "agentos.memory.operation",
      "agentos.memory.method",
      "agentos.memory.outcome",
      "agentos.memory.degradation.class",
    ],
    "completed_memory_operations",
  ),
  [AGENTOS_MEMORY_METRICS.operationDuration]: metricDefinition(
    AGENTOS_MEMORY_METRICS.operationDuration,
    "memory",
    "histogram",
    "s",
    [
      "agentos.memory.operation",
      "agentos.memory.method",
      "agentos.memory.outcome",
    ],
    "memory_operation_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_MEMORY_METRICS.candidates]: metricDefinition(
    AGENTOS_MEMORY_METRICS.candidates,
    "memory",
    "histogram",
    "{candidate}",
    ["agentos.memory.method", "agentos.memory.outcome"],
    "candidate_count_per_retrieval",
    countBuckets,
  ),
  [AGENTOS_MEMORY_METRICS.attachments]: metricDefinition(
    AGENTOS_MEMORY_METRICS.attachments,
    "memory",
    "histogram",
    "{attachment}",
    ["agentos.memory.method", "agentos.memory.outcome"],
    "attachment_count_per_retrieval",
    countBuckets,
  ),
  [AGENTOS_MEMORY_METRICS.attachedBytes]: metricDefinition(
    AGENTOS_MEMORY_METRICS.attachedBytes,
    "memory",
    "histogram",
    "By",
    ["agentos.memory.method", "agentos.memory.outcome"],
    "attached_memory_bytes_per_retrieval",
    byteBuckets,
  ),
  [AGENTOS_MEMORY_METRICS.indexAge]: metricDefinition(
    AGENTOS_MEMORY_METRICS.indexAge,
    "memory",
    "histogram",
    "s",
    ["agentos.memory.method", "agentos.memory.index.state"],
    "derivative_index_age",
    durationBuckets,
  ),
  [AGENTOS_ACCESS_METRICS.decisions]: metricDefinition(
    AGENTOS_ACCESS_METRICS.decisions,
    "access",
    "counter",
    "{decision}",
    [
      "agentos.access.operation",
      "agentos.access.decision",
      "agentos.access.reason",
      "agentos.access.dependency",
    ],
    "completed_access_decisions",
  ),
  [AGENTOS_ACCESS_METRICS.decisionDuration]: metricDefinition(
    AGENTOS_ACCESS_METRICS.decisionDuration,
    "access",
    "histogram",
    "s",
    ["agentos.access.operation", "agentos.access.decision"],
    "access_decision_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_ACCESS_METRICS.revocationDuration]: metricDefinition(
    AGENTOS_ACCESS_METRICS.revocationDuration,
    "access",
    "histogram",
    "s",
    ["agentos.access.decision", "agentos.access.dependency"],
    "revocation_visibility_duration",
    durationBuckets,
  ),
  [AGENTOS_ACCESS_METRICS.profileReloadDuration]: metricDefinition(
    AGENTOS_ACCESS_METRICS.profileReloadDuration,
    "access",
    "histogram",
    "s",
    ["agentos.access.decision", "agentos.access.dependency"],
    "profile_reload_visibility_duration",
    durationBuckets,
  ),
  [AGENTOS_ACCESS_METRICS.credentialReleases]: metricDefinition(
    AGENTOS_ACCESS_METRICS.credentialReleases,
    "access",
    "counter",
    "{release}",
    ["agentos.access.decision", "agentos.access.credential.outcome"],
    "credential_adapter_release_outcomes",
  ),
  [AGENTOS_ACCESS_METRICS.protocolOperations]: metricDefinition(
    AGENTOS_ACCESS_METRICS.protocolOperations,
    "access",
    "counter",
    "{operation}",
    [
      "agentos.protocol.name",
      "agentos.protocol.operation",
      "agentos.access.decision",
    ],
    "authorized_http_and_mcp_operations",
  ),
  [AGENTOS_PROTOCOL_METRICS.operations]: metricDefinition(
    AGENTOS_PROTOCOL_METRICS.operations,
    "protocol",
    "counter",
    "{operation}",
    [
      "agentos.protocol.name",
      "agentos.protocol.operation",
      "agentos.protocol.outcome",
      "agentos.protocol.fallback",
    ],
    "completed_protocol_operations",
  ),
  [AGENTOS_PROTOCOL_METRICS.operationDuration]: metricDefinition(
    AGENTOS_PROTOCOL_METRICS.operationDuration,
    "protocol",
    "histogram",
    "s",
    [
      "agentos.protocol.name",
      "agentos.protocol.operation",
      "agentos.protocol.outcome",
    ],
    "protocol_operation_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_PROTOCOL_METRICS.fallbacks]: metricDefinition(
    AGENTOS_PROTOCOL_METRICS.fallbacks,
    "protocol",
    "counter",
    "{fallback}",
    ["agentos.protocol.name", "agentos.protocol.fallback"],
    "protocol_fallback_transitions",
  ),
  [AGENTOS_RESILIENCE_METRIC_NAMES.observations]: metricDefinition(
    AGENTOS_RESILIENCE_METRIC_NAMES.observations,
    "recovery",
    "counter",
    "{observation}",
    [
      "agentos.resilience.source",
      "agentos.resilience.phase",
      "agentos.resilience.evidence",
      "agentos.resilience.outcome",
      "agentos.resilience.cause",
      "agentos.resilience.recovery",
    ],
    "observed_resilience_boundaries",
  ),
  [AGENTOS_RESILIENCE_METRIC_NAMES.operations]: metricDefinition(
    AGENTOS_RESILIENCE_METRIC_NAMES.operations,
    "recovery",
    "counter",
    "{operation}",
    [
      "agentos.resilience.outcome",
      "agentos.resilience.cause",
      "agentos.resilience.recovery",
    ],
    "completed_resilience_operations",
  ),
  [AGENTOS_RESILIENCE_METRIC_NAMES.operationDuration]: metricDefinition(
    AGENTOS_RESILIENCE_METRIC_NAMES.operationDuration,
    "recovery",
    "histogram",
    "s",
    ["agentos.resilience.outcome", "agentos.resilience.cause"],
    "resilience_operation_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_RESILIENCE_METRIC_NAMES.topologyDecisions]: metricDefinition(
    AGENTOS_RESILIENCE_METRIC_NAMES.topologyDecisions,
    "topology",
    "counter",
    "{decision}",
    ["agentos.topology.action", "agentos.topology.reason"],
    "first_mate_topology_decisions",
  ),
  [AGENTOS_RESILIENCE_METRIC_NAMES.readinessChecks]: metricDefinition(
    AGENTOS_RESILIENCE_METRIC_NAMES.readinessChecks,
    "readiness",
    "counter",
    "{check}",
    ["agentos.readiness.component", "agentos.readiness.outcome"],
    "semantic_readiness_checks",
  ),
  [AGENTOS_TELEMETRY_PIPELINE_METRICS.events]: metricDefinition(
    AGENTOS_TELEMETRY_PIPELINE_METRICS.events,
    "telemetry_pipeline",
    "counter",
    "{event}",
    [
      "agentos.telemetry.signal",
      "agentos.telemetry.stage",
      "agentos.telemetry.outcome",
      "agentos.telemetry.reason",
    ],
    "telemetry_pipeline_events",
  ),
  [AGENTOS_TELEMETRY_PIPELINE_METRICS.queueSize]: metricDefinition(
    AGENTOS_TELEMETRY_PIPELINE_METRICS.queueSize,
    "telemetry_pipeline",
    "up_down_counter",
    "{batch}",
    ["agentos.telemetry.signal", "agentos.telemetry.stage"],
    "currently_queued_batches",
  ),
  [AGENTOS_TELEMETRY_PIPELINE_METRICS.exportDuration]: metricDefinition(
    AGENTOS_TELEMETRY_PIPELINE_METRICS.exportDuration,
    "telemetry_pipeline",
    "histogram",
    "s",
    ["agentos.telemetry.signal", "agentos.telemetry.outcome"],
    "telemetry_export_wall_duration",
    durationBuckets,
  ),
  [AGENTOS_TELEMETRY_PIPELINE_METRICS.droppedBatches]: metricDefinition(
    AGENTOS_TELEMETRY_PIPELINE_METRICS.droppedBatches,
    "telemetry_pipeline",
    "counter",
    "{batch}",
    ["agentos.telemetry.signal", "agentos.telemetry.reason"],
    "dropped_telemetry_batches",
  ),
});

export const AGENTOS_TELEMETRY_FORBIDDEN_ATTRIBUTE_KEYS = Object.freeze([
  "authorization",
  "cookie",
  "db.query.text",
  "db.statement",
  "error.message",
  "exception.message",
  "exception.stacktrace",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.prompt",
  "gen_ai.system_instructions",
  "http.request.body",
  "http.request.header.authorization",
  "http.request.header.cookie",
  "http.response.body",
  "http.response.header.set_cookie",
  "agentos.assignment.brief",
  "agentos.inbox.body",
  "agentos.memory.body",
  "agentos.memory.embedding",
  "agentos.memory.query",
  "agentos.memory.snippet",
  "agentos.provider.credential",
  "agentos.provider.identity",
  "agentos.provider.resource_id",
  "agentos.repository.name",
  "agentos.session.transcript",
  "agentos.tool.arguments",
  "agentos.tool.result",
  "provider.account.email",
  "provider.account.id",
  "tool.arguments",
  "tool.result",
]);

export const AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS = Object.freeze(
  Object.values(AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS)
    .filter((definition) =>
      definition.sensitivity === "restricted" ||
      definition.cardinality === "unbounded"
    )
    .map(({ name }) => name)
    .sort(),
);
