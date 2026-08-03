import { Effect, FileSystem, Path, Schema } from "effect";

import {
  AccessResilienceRunV1Schema,
  compileAccessResilienceVerdict,
} from "../access/resilience-conformance.ts";
import {
  compileProtocolResilienceVerdict,
  ProtocolResilienceRunV1Schema,
} from "../protocol/resilience-conformance.ts";

const values = <const Values extends ReadonlyArray<string>>(
  ...entries: Values
) => entries;

export const AGENTOS_RESILIENCE_SCENARIOS = values(
  "workload.pvc.fresh_start",
  "workload.pvc.existing_start",
  "workload.mate.replacement",
  "workload.crewmate.replacement",
  "workload.pi.exact_resume",
  "workload.secret.privacy",
  "workload.secret.file_modes",
  "workload.resources.cpu_quota",
  "workload.resources.memory_quota",
  "workload.pvc.retained_node_affinity",
  "workload.cross_namespace.denied",
  "workload.admission.denied",
  "workload.spec.invalid",
  "workload.spec.conflict",
  "workload.render.interrupted",
  "workload.apply.interrupted",
  "runtime.listener.loss",
  "runtime.herdr.loss",
  "runtime.harness.loss",
  "runtime.operation.prepared",
  "runtime.operation.applied",
  "runtime.operation.workload_ready",
  "runtime.operation.harness_ready",
  "runtime.operation.recovery_required",
  "runtime.operation.completed",
  "runtime.operation.failed",
  "runtime.operation.superseded",
  "gateway.config.malformed",
  "gateway.provider.unauthorized_401",
  "gateway.provider.rate_limited_429",
  "gateway.provider.overload",
  "gateway.provider.transport_failure",
  "gateway.provider.stream_failure",
  "access.identity.expired_token",
  "access.identity.refresh_failed",
  "access.identity.stale_projection",
  "access.identity.scope_mismatch",
  "access.identity.revocation",
  "supervision.retry.exhausted",
  "supervision.retry.resumed",
  "supervision.retry.reassigned",
  "supervision.retry.stopped",
);

export const AgentOSResilienceScenarioIdSchema = Schema.Literals(
  AGENTOS_RESILIENCE_SCENARIOS,
);
const EvidenceSourceSchema = Schema.Literals([
  "effect_fixture",
  "rendered_resource",
  "pglite",
  "disposable_kubernetes",
]);
const EvidenceStatusSchema = Schema.Literals([
  "observed",
  "unobserved",
  "failed",
]);
const OutcomeSchema = Schema.Literals([
  "succeeded",
  "denied",
  "degraded",
  "failed_closed",
  "recovered",
]);
const FailureClassSchema = Schema.Literals([
  "none",
  "replacement",
  "malformed_configuration",
  "authentication",
  "rate_limit",
  "overload",
  "transport",
  "stream",
  "token_expired",
  "refresh_failed",
  "stale_projection",
  "scope_mismatch",
  "revoked",
  "secret_privacy",
  "quota",
  "node_affinity",
  "listener_loss",
  "herdr_loss",
  "harness_loss",
  "invalid_spec",
  "spec_conflict",
  "render_interrupted",
  "apply_interrupted",
  "retry_exhausted",
  "cross_namespace",
  "admission",
  "operation_failed",
  "operation_superseded",
]);
const RecoverySchema = Schema.Literals([
  "not_required",
  "same_pvc_restart",
  "native_session_resume",
  "configuration_rejected",
  "provider_error_preserved",
  "bounded_retry",
  "projection_refresh",
  "revocation_observed",
  "operation_journal_repair_forward",
  "postgresql_listener_reconnect",
  "herdr_attach",
  "harness_restart",
  "supervisor_resume",
  "supervisor_reassignment",
  "supervisor_stop",
]);
const RollbackSchema = Schema.Literals([
  "observed",
  "not_required",
  "unobserved",
]);
const WorkAuthoritySchema = Schema.Literal("postgresql");
const SessionAuthoritySchema = Schema.Literals([
  "provider_native",
  "not_applicable",
]);
const WorkloadAuthoritySchema = Schema.Literal("kubernetes");
const IdentityAuthoritySchema = Schema.Literals([
  "kubernetes_postgresql_openfga",
  "not_applicable",
]);
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
const KubernetesContextSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^(?:kind|vcluster)-[a-z0-9-]+$/),
  ),
);
const ApprovalReferenceSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^approval:[0-9A-Za-z._:-]+$/),
  ),
);
const ObservedContentSchema = Schema.Literals([
  "prompt",
  "brief",
  "inbox_body",
  "transcript",
  "plan",
  "terminal_payload",
  "file_payload",
  "tool_payload",
  "a2a_artifact",
  "credential",
  "provider_identity",
  "private_memory",
]);
const ImageNameSchema = Schema.Literals([
  "agentos",
  "agentgateway",
  "openfga",
  "postgresql",
  "kubernetes-node",
]);

const AuthoritySchema = Schema.Struct({
  work: WorkAuthoritySchema,
  session: SessionAuthoritySchema,
  workload: WorkloadAuthoritySchema,
  identity: IdentityAuthoritySchema,
});

export const AgentOSResilienceObservationV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  scenario: AgentOSResilienceScenarioIdSchema,
  source: EvidenceSourceSchema,
  status: EvidenceStatusSchema,
  outcome: OutcomeSchema,
  failureClass: FailureClassSchema,
  recovery: RecoverySchema,
  rollback: RollbackSchema,
  authorities: AuthoritySchema,
  attachable: Schema.Boolean,
  observable: Schema.Boolean,
  workloadSpecDigest: Schema.NullOr(DigestSchema),
  renderDigest: Schema.NullOr(DigestSchema),
  trace: Schema.Struct({
    protected: Schema.Boolean,
    metricDimensions: Schema.Array(MetricDimensionSchema).pipe(
      Schema.check(Schema.isMaxLength(16)),
    ),
    observedContent: Schema.Array(ObservedContentSchema).pipe(
      Schema.check(Schema.isMaxLength(12)),
    ),
  }),
});

export const AgentOSResilienceRunV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  revision: RevisionSchema,
  environment: Schema.Struct({
    isolation: Schema.Literal("disposable"),
    context: KubernetesContextSchema,
    approvalReference: ApprovalReferenceSchema,
    productionEndpointContacted: Schema.Boolean,
    destroyedAfterRun: Schema.Boolean,
  }),
  images: Schema.Array(Schema.Struct({
    name: ImageNameSchema,
    digest: DigestSchema,
  })).pipe(Schema.check(Schema.isMaxLength(6))),
  observations: Schema.Array(AgentOSResilienceObservationV1Schema).pipe(
    Schema.check(Schema.isMaxLength(AGENTOS_RESILIENCE_SCENARIOS.length + 1)),
  ),
  protocol: ProtocolResilienceRunV1Schema,
  access: AccessResilienceRunV1Schema,
});

export type AgentOSResilienceScenarioId =
  typeof AgentOSResilienceScenarioIdSchema.Type;
export type AgentOSResilienceObservationV1 =
  typeof AgentOSResilienceObservationV1Schema.Type;
export type AgentOSResilienceRunV1 = typeof AgentOSResilienceRunV1Schema.Type;

const RegressionKindSchema = Schema.Literals(["original", "held_out"]);
const RegressionIssueSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^#[1-9][0-9]*$/)),
);
const RegressionPathSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(256),
    Schema.isPattern(
      /^(?:benchmarks|clis|database|packages|services|tooling)\/[0-9A-Za-z._/-]+\.effect\.test\.ts$/,
    ),
  ),
);
const RegressionTitleSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
);

export const ResilienceRegressionSourceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  scenario: AgentOSResilienceScenarioIdSchema,
  kind: RegressionKindSchema,
  issue: RegressionIssueSchema,
  path: RegressionPathSchema,
  title: RegressionTitleSchema,
});

export type ResilienceRegressionSourceV1 =
  typeof ResilienceRegressionSourceV1Schema.Type;

export interface AgentOSResilienceScenarioDefinition {
  readonly outcome: typeof OutcomeSchema.Type;
  readonly failureClass: typeof FailureClassSchema.Type;
  readonly recovery: typeof RecoverySchema.Type;
  readonly rollback: typeof RollbackSchema.Type;
  readonly minimumSource: typeof EvidenceSourceSchema.Type;
  readonly authorities: typeof AuthoritySchema.Type;
  readonly requiresAttachable: boolean;
  readonly requiresWorkloadDigests: boolean;
}

const GateErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "production_boundary_contacted",
  "disposable_cleanup_missing",
  "image_pin_missing",
  "child_evidence_drift",
  "protocol_gate_failed",
  "access_gate_failed",
  "scenario_missing",
  "scenario_duplicate",
  "scenario_unobserved",
  "scenario_failed",
  "outcome_mismatch",
  "proof_source_too_weak",
  "digest_continuity_missing",
  "rollback_missing",
  "content_leak",
  "metric_cardinality_violation",
  "trace_not_protected",
  "authority_violation",
  "observability_missing",
  "attachability_missing",
]);

export class AgentOSResilienceGateError extends Schema.TaggedErrorClass<AgentOSResilienceGateError>()(
  "AgentOSResilienceGateError",
  {
    code: GateErrorCodeSchema,
    scenario: Schema.NullOr(AgentOSResilienceScenarioIdSchema),
  },
) {}

const RegressionSourceErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "scenario_reference_missing",
  "scenario_reference_duplicate",
  "original_held_out_reused",
  "path_outside_repository",
  "file_unavailable",
  "title_missing",
  "title_ambiguous",
  "non_effect_regression",
]);

export class ResilienceRegressionSourceError extends Schema.TaggedErrorClass<ResilienceRegressionSourceError>()(
  "ResilienceRegressionSourceError",
  {
    code: RegressionSourceErrorCodeSchema,
    scenario: Schema.NullOr(AgentOSResilienceScenarioIdSchema),
    kind: Schema.NullOr(RegressionKindSchema),
  },
) {}

const NativeAuthorities: AgentOSResilienceScenarioDefinition["authorities"] = {
  work: "postgresql",
  session: "provider_native",
  workload: "kubernetes",
  identity: "not_applicable",
};
const NonSessionAuthorities: AgentOSResilienceScenarioDefinition["authorities"] = {
  work: "postgresql",
  session: "not_applicable",
  workload: "kubernetes",
  identity: "not_applicable",
};
const AccessAuthorities: AgentOSResilienceScenarioDefinition["authorities"] = {
  work: "postgresql",
  session: "provider_native",
  workload: "kubernetes",
  identity: "kubernetes_postgresql_openfga",
};

export function agentOSResilienceScenarioDefinition(
  scenario: AgentOSResilienceScenarioId,
): AgentOSResilienceScenarioDefinition {
  switch (scenario) {
    case "workload.pvc.fresh_start":
      return definition(
        "succeeded",
        "none",
        "not_required",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "workload.pvc.existing_start":
    case "workload.mate.replacement":
    case "workload.crewmate.replacement":
      return definition(
        "recovered",
        "replacement",
        "same_pvc_restart",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "workload.pi.exact_resume":
      return definition(
        "recovered",
        "replacement",
        "native_session_resume",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "workload.secret.privacy":
      return definition(
        "denied",
        "secret_privacy",
        "not_required",
        "rendered_resource",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.secret.file_modes":
      return definition(
        "succeeded",
        "none",
        "not_required",
        "disposable_kubernetes",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.resources.cpu_quota":
    case "workload.resources.memory_quota":
      return definition(
        "denied",
        "quota",
        "not_required",
        "disposable_kubernetes",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.pvc.retained_node_affinity":
      return definition(
        "recovered",
        "node_affinity",
        "same_pvc_restart",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "workload.cross_namespace.denied":
      return definition(
        "denied",
        "cross_namespace",
        "not_required",
        "disposable_kubernetes",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.admission.denied":
      return definition(
        "denied",
        "admission",
        "not_required",
        "disposable_kubernetes",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.spec.invalid":
      return definition(
        "denied",
        "invalid_spec",
        "configuration_rejected",
        "effect_fixture",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.spec.conflict":
      return definition(
        "denied",
        "spec_conflict",
        "configuration_rejected",
        "pglite",
        NonSessionAuthorities,
        false,
        true,
      );
    case "workload.render.interrupted":
      return definition(
        "recovered",
        "render_interrupted",
        "operation_journal_repair_forward",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "workload.apply.interrupted":
      return definition(
        "recovered",
        "apply_interrupted",
        "operation_journal_repair_forward",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "runtime.listener.loss":
      return definition(
        "degraded",
        "listener_loss",
        "postgresql_listener_reconnect",
        "effect_fixture",
        NativeAuthorities,
        true,
        false,
      );
    case "runtime.herdr.loss":
      return definition(
        "degraded",
        "herdr_loss",
        "postgresql_listener_reconnect",
        "effect_fixture",
        NativeAuthorities,
        true,
        false,
      );
    case "runtime.harness.loss":
      return definition(
        "degraded",
        "harness_loss",
        "herdr_attach",
        "effect_fixture",
        NativeAuthorities,
        true,
        false,
      );
    case "runtime.operation.prepared":
    case "runtime.operation.applied":
    case "runtime.operation.workload_ready":
    case "runtime.operation.harness_ready":
    case "runtime.operation.completed":
      return definition(
        "succeeded",
        "none",
        "not_required",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "runtime.operation.recovery_required":
      return definition(
        "recovered",
        "apply_interrupted",
        "operation_journal_repair_forward",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "runtime.operation.failed":
      return definition(
        "failed_closed",
        "operation_failed",
        "not_required",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "runtime.operation.superseded":
      return definition(
        "recovered",
        "operation_superseded",
        "operation_journal_repair_forward",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "gateway.config.malformed":
      return definition(
        "denied",
        "malformed_configuration",
        "configuration_rejected",
        "effect_fixture",
        AccessAuthorities,
        false,
        false,
      );
    case "gateway.provider.unauthorized_401":
      return definition(
        "failed_closed",
        "authentication",
        "provider_error_preserved",
        "effect_fixture",
        AccessAuthorities,
        true,
        false,
      );
    case "gateway.provider.rate_limited_429":
      return definition(
        "failed_closed",
        "rate_limit",
        "bounded_retry",
        "effect_fixture",
        AccessAuthorities,
        true,
        false,
      );
    case "gateway.provider.overload":
      return definition(
        "failed_closed",
        "overload",
        "bounded_retry",
        "effect_fixture",
        AccessAuthorities,
        true,
        false,
      );
    case "gateway.provider.transport_failure":
      return definition(
        "failed_closed",
        "transport",
        "bounded_retry",
        "effect_fixture",
        AccessAuthorities,
        true,
        false,
      );
    case "gateway.provider.stream_failure":
      return definition(
        "failed_closed",
        "stream",
        "bounded_retry",
        "effect_fixture",
        AccessAuthorities,
        true,
        false,
      );
    case "access.identity.expired_token":
      return definition(
        "denied",
        "token_expired",
        "projection_refresh",
        "effect_fixture",
        AccessAuthorities,
        false,
        false,
      );
    case "access.identity.refresh_failed":
      return definition(
        "denied",
        "refresh_failed",
        "configuration_rejected",
        "effect_fixture",
        AccessAuthorities,
        false,
        false,
      );
    case "access.identity.stale_projection":
      return definition(
        "denied",
        "stale_projection",
        "projection_refresh",
        "effect_fixture",
        AccessAuthorities,
        false,
        false,
      );
    case "access.identity.scope_mismatch":
      return definition(
        "denied",
        "scope_mismatch",
        "not_required",
        "effect_fixture",
        AccessAuthorities,
        false,
        false,
      );
    case "access.identity.revocation":
      return definition(
        "denied",
        "revoked",
        "revocation_observed",
        "disposable_kubernetes",
        AccessAuthorities,
        false,
        false,
      );
    case "supervision.retry.exhausted":
      return definition(
        "degraded",
        "retry_exhausted",
        "not_required",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "supervision.retry.resumed":
      return definition(
        "recovered",
        "retry_exhausted",
        "supervisor_resume",
        "disposable_kubernetes",
        NativeAuthorities,
        true,
        true,
      );
    case "supervision.retry.reassigned":
      return definition(
        "recovered",
        "retry_exhausted",
        "supervisor_reassignment",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
    case "supervision.retry.stopped":
      return definition(
        "failed_closed",
        "retry_exhausted",
        "supervisor_stop",
        "pglite",
        NativeAuthorities,
        true,
        true,
      );
  }
}

interface RegressionTest {
  readonly issue: ResilienceRegressionSourceV1["issue"];
  readonly path: ResilienceRegressionSourceV1["path"];
  readonly title: ResilienceRegressionSourceV1["title"];
}

const WorkloadLive = regressionTest(
  "packages/agentos/src/workloads/tests/disposable-recovery.effect.test.ts",
  "proves fresh and retained Mate/Crewmate lifecycle, quota, affinity, Secret modes, and repair",
  "#127",
);
const WorkloadPlans = regressionTest(
  "packages/agentos/src/workloads/tests/disposable-recovery.effect.test.ts",
  "renders exact persistent and interactive plans from native structured resources",
  "#127",
);
const DomainLive = regressionTest(
  "packages/agentos/resources/roles/secondmate/kubernetes/tests/domain-lifecycle.effect.test.ts",
  "proves domain-local child lifecycle, sibling denial, supervision, and PVC retention",
  "#79",
);
const ProtocolLive = regressionTest(
  "packages/agentos/src/protocol/tests/disposable-kubernetes.effect.test.ts",
  "proves projected identity, direct-edge RBAC, denial, revocation, and cleanup",
  "#130",
);
const SecretLive = regressionTest(
  "packages/agentos/runtime/kubernetes/tests/secret-lifecycle.effect.test.ts",
  "proves retry, rotation, conflict, takeover, projection, rollback, and revocation",
  "#24",
);
const CompilerInteractive = regressionTest(
  "packages/agentos/src/workloads/tests/compiler-kustomize.effect.test.ts",
  "renders one isolated interactive Crewmate from ordinary native resources",
  "#127",
);
const CompilerMate = regressionTest(
  "packages/agentos/src/workloads/tests/compiler-kustomize.effect.test.ts",
  "renders the persistent Mate and exact released domain controls",
  "#127",
);
const CompilerSecret = regressionTest(
  "packages/agentos/src/workloads/tests/compiler.effect.test.ts",
  "rejects unknown literal Secret fields with an exact safe path",
  "#123",
);
const CompilerResources = regressionTest(
  "packages/agentos/src/workloads/tests/compiler.effect.test.ts",
  "enforces workload resource ceilings and unique profile references",
  "#123",
);
const CompilerBoundary = regressionTest(
  "packages/agentos/src/workloads/tests/compiler.effect.test.ts",
  "rejects storage, ServiceAccount, and protocol boundary violations at exact safe fields",
  "#123",
);
const CompilerLifecycle = regressionTest(
  "packages/agentos/src/workloads/tests/compiler.effect.test.ts",
  "rejects unsupported profiles and inconsistent lifecycle ownership",
  "#123",
);
const RecoveryJoin = regressionTest(
  "packages/agentos/src/workloads/tests/recovery-conformance.effect.test.ts",
  "joins exact compiler, render, SQL journal, and protected trace provenance",
  "#127",
);
const JournalBoundary = regressionTest(
  "database/tests/runtime-operation-journal.effect.test.ts",
  "records boundaries, repair-forward recovery, and immutable completion",
  "#23",
);
const JournalConflict = regressionTest(
  "database/tests/runtime-operation-journal.effect.test.ts",
  "begins one hierarchy-owned operation and fails closed on conflicts",
  "#23",
);
const JournalDigestConflict = regressionTest(
  "database/tests/runtime-operation-journal.effect.test.ts",
  "rejects a changed workload spec even when its rendered manifest is identical",
  "#127",
);
const JournalSupersede = regressionTest(
  "database/tests/runtime-operation-journal.effect.test.ts",
  "supersedes without replacing durable Agent or work identity",
  "#23",
);
const ReadinessHealthy = regressionTest(
  "packages/agentos/runtime/tests/readiness.effect.test.ts",
  "reports a fully prepared Mate ready without reading auth contents",
  "#20",
);
const ReadinessListener = regressionTest(
  "packages/agentos/runtime/tests/readiness.effect.test.ts",
  "distinguishes database identity, database credential, listener, and catch-up recovery",
  "#20",
);
const ReadinessHarness = regressionTest(
  "packages/agentos/runtime/tests/readiness.effect.test.ts",
  "distinguishes Crewmate harness, Assignment, brief, credential, and confirmation",
  "#20",
);
const RuntimeNativeRecovery = regressionTest(
  "packages/agentos/runtime/tests/runtime.effect.test.ts",
  "keeps a native recovery path when relocated Mate startup fails",
  "#83",
);
const RuntimeStalePane = regressionTest(
  "packages/agentos/runtime/tests/runtime.effect.test.ts",
  "restarts a persisted Pi session when Herdr restored only stale pane metadata",
  "#83",
);
const GatewayConfig = regressionTest(
  "services/ai-gateway/tests/config.effect.test.ts",
  "rejects missing shared auth and malformed runtime bounds",
  "#32",
);
const AgentgatewayContract = regressionTest(
  "services/agentgateway/tests/conformance.effect.test.ts",
  "preserves AgentOS authorization, credential, provider, stream, MCP, telemetry, and reload semantics",
  "#35",
);
const AgentgatewayInvalid = regressionTest(
  "services/agentgateway/tests/conformance.effect.test.ts",
  "reports invalid subprocess contracts as tagged failures",
  "#35",
);
const ProviderTransport = regressionTest(
  "services/ai-gateway/tests/provider-http.effect.test.ts",
  "maps request construction and transport failures to closed typed errors",
  "#32",
);
const ProviderStream = regressionTest(
  "services/ai-gateway/tests/provider-http.effect.test.ts",
  "keeps provider stream defects typed and payload-free",
  "#32",
);
const ForwardRateLimit = regressionTest(
  "services/ai-gateway/tests/forward.effect.test.ts",
  "settles provider rejections with zero usage and preserves their status/body",
  "#32",
);
const ForwardProviderFailureMatrix = regressionTest(
  "services/ai-gateway/tests/forward.effect.test.ts",
  "preserves distinct provider 401, 429, and overload responses",
  "#84",
);
const ForwardTransport = regressionTest(
  "services/ai-gateway/tests/forward.effect.test.ts",
  "releases the route and returns a finite response when provider connection fails",
  "#32",
);
const ForwardStream = regressionTest(
  "services/ai-gateway/tests/forward.effect.test.ts",
  "keeps a provider stream failure distinct and does not settle unknown usage",
  "#32",
);
const QuotaFailures = regressionTest(
  "services/ai-gateway/tests/quota.effect.test.ts",
  "keeps reauthentication, provider rejection, malformed data, and transport distinct",
  "#34",
);
const AccountRefresh = regressionTest(
  "services/ai-gateway/tests/accounts.effect.test.ts",
  "persists reauthentication after definitive or identity-changing refresh failures",
  "#34",
);
const AccountRotation = regressionTest(
  "services/ai-gateway/tests/accounts.effect.test.ts",
  "does not let a stale rejected token invalidate a rotated login",
  "#34",
);
const IdentityExpiry = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "caps positive caching, honors token expiry, and invalidates by identity",
  "#94",
);
const IdentityAudience = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "requires the dedicated audience and exact live bound UIDs",
  "#94",
);
const IdentityAvailability = regressionTest(
  "packages/agentos/src/access/tests/identity.effect.test.ts",
  "never turns TokenReview or identity-store unavailability into identity",
  "#94",
);
const PolicySnapshot = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "keeps database, identity, and stale-policy snapshot failures distinct",
  "#94",
);
const PolicyFreshness = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "revalidates snapshot freshness, uniqueness, scope, and bounded expiry",
  "#94",
);
const PolicyRoute = regressionTest(
  "packages/agentos/src/access/tests/policy-decision.effect.test.ts",
  "rejects caller-controlled identity and invalid provider routes before dependencies",
  "#94",
);
const ControlRevocation = regressionTest(
  "packages/agentos/src/access/tests/control-plane.effect.test.ts",
  "interrupts a stalled revocation at the published SLO",
  "#96",
);
const RetryCeiling = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "derives a closed retry ceiling for every distinct failure class",
  "#83",
);
const RetryExhaustion = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "exhausts only at the exact class ceiling and completes a successor epoch",
  "#83",
);
const RetryResume = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "resumes exactly once under parent authority without replacing durable identity",
  "#83",
);
const RetryAuthority = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "requires explicit authority evidence after authentication exhaustion",
  "#83",
);
const RetryReassign = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "atomically reassigns exhausted work through append-only Assignment history",
  "#83",
);
const RetryStop = regressionTest(
  "database/tests/assignment-execution-recovery.effect.test.ts",
  "stops exhausted work once while keeping its report on the Assignment",
  "#83",
);
const RetryLive = regressionTest(
  "packages/agentos/src/workloads/tests/disposable-recovery.effect.test.ts",
  "proves transient resume plus held-out authority and capacity denial in PostgreSQL",
  "#83",
);

export const RESILIENCE_REGRESSION_SOURCES: ReadonlyArray<ResilienceRegressionSourceV1> = [
  ...regressionPair("workload.pvc.fresh_start", CompilerMate, WorkloadPlans),
  ...regressionPair("workload.pvc.existing_start", WorkloadLive, DomainLive),
  ...regressionPair("workload.mate.replacement", DomainLive, WorkloadLive),
  ...regressionPair("workload.crewmate.replacement", WorkloadLive, DomainLive),
  ...regressionPair("workload.pi.exact_resume", ProtocolLive, RuntimeStalePane),
  ...regressionPair("workload.secret.privacy", CompilerSecret, PolicyRoute),
  ...regressionPair("workload.secret.file_modes", SecretLive, CompilerInteractive),
  ...regressionPair("workload.resources.cpu_quota", CompilerResources, WorkloadLive),
  ...regressionPair("workload.resources.memory_quota", WorkloadLive, CompilerResources),
  ...regressionPair("workload.pvc.retained_node_affinity", WorkloadLive, DomainLive),
  ...regressionPair("workload.cross_namespace.denied", DomainLive, ProtocolLive),
  ...regressionPair("workload.admission.denied", WorkloadLive, DomainLive),
  ...regressionPair("workload.spec.invalid", CompilerBoundary, CompilerLifecycle),
  ...regressionPair("workload.spec.conflict", JournalDigestConflict, JournalConflict),
  ...regressionPair("workload.render.interrupted", RecoveryJoin, JournalBoundary),
  ...regressionPair("workload.apply.interrupted", JournalBoundary, WorkloadLive),
  ...regressionPair("runtime.listener.loss", ReadinessListener, IdentityAvailability),
  ...regressionPair("runtime.herdr.loss", RuntimeNativeRecovery, WorkloadLive),
  ...regressionPair("runtime.harness.loss", ReadinessHarness, RuntimeNativeRecovery),
  ...regressionPair("runtime.operation.prepared", JournalBoundary, JournalConflict),
  ...regressionPair("runtime.operation.applied", JournalBoundary, RecoveryJoin),
  ...regressionPair("runtime.operation.workload_ready", JournalBoundary, ReadinessHealthy),
  ...regressionPair("runtime.operation.harness_ready", JournalBoundary, ReadinessHarness),
  ...regressionPair("runtime.operation.recovery_required", JournalBoundary, RecoveryJoin),
  ...regressionPair("runtime.operation.completed", JournalBoundary, JournalConflict),
  ...regressionPair("runtime.operation.failed", JournalSupersede, JournalBoundary),
  ...regressionPair("runtime.operation.superseded", JournalSupersede, RecoveryJoin),
  ...regressionPair("gateway.config.malformed", GatewayConfig, AgentgatewayInvalid),
  ...regressionPair("gateway.provider.unauthorized_401", ForwardProviderFailureMatrix, QuotaFailures),
  ...regressionPair("gateway.provider.rate_limited_429", ForwardProviderFailureMatrix, ForwardRateLimit),
  ...regressionPair("gateway.provider.overload", ForwardProviderFailureMatrix, AgentgatewayContract),
  ...regressionPair("gateway.provider.transport_failure", ProviderTransport, ForwardTransport),
  ...regressionPair("gateway.provider.stream_failure", ProviderStream, ForwardStream),
  ...regressionPair("access.identity.expired_token", IdentityExpiry, PolicyFreshness),
  ...regressionPair("access.identity.refresh_failed", AccountRefresh, AccountRotation),
  ...regressionPair("access.identity.stale_projection", PolicySnapshot, PolicyFreshness),
  ...regressionPair("access.identity.scope_mismatch", IdentityAudience, PolicyRoute),
  ...regressionPair("access.identity.revocation", ControlRevocation, ProtocolLive),
  ...regressionPair("supervision.retry.exhausted", RetryCeiling, RetryExhaustion),
  ...regressionPair("supervision.retry.resumed", RetryResume, RetryLive),
  ...regressionPair("supervision.retry.reassigned", RetryReassign, RetryAuthority),
  ...regressionPair("supervision.retry.stopped", RetryStop, RetryExhaustion),
];

const RequiredImages = values(
  "agentos",
  "agentgateway",
  "openfga",
  "postgresql",
  "kubernetes-node",
);
const AllowedMetricDimensions = values(
  "component",
  "operation",
  "outcome",
  "failure_class",
  "recovery",
);
const RegressionVerificationOptionsSchema = Schema.Struct({
  repositoryRoot: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  ),
  references: Schema.Array(ResilienceRegressionSourceV1Schema).pipe(
    Schema.check(Schema.isMaxLength(AGENTOS_RESILIENCE_SCENARIOS.length * 2 + 1)),
  ),
});

export const verifyResilienceRegressionSources = Effect.fn(
  "agentos.resilience.verifyRegressionSources",
)(function*(input: unknown) {
  const options = yield* Schema.decodeUnknownEffect(
    RegressionVerificationOptionsSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => regressionSourceError("invalid_contract", null, null)),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const repositoryRoot = paths.resolve(options.repositoryRoot);

  for (const reference of options.references) {
    const resolved = paths.resolve(repositoryRoot, reference.path);
    const contained = paths.relative(repositoryRoot, resolved);
    if (
      contained === ".." ||
      contained.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(contained)
    ) {
      return yield* regressionSourceError(
        "path_outside_repository",
        reference.scenario,
        reference.kind,
      );
    }
    const source = yield* fileSystem.readFileString(resolved).pipe(
      Effect.mapError(() =>
        regressionSourceError(
          "file_unavailable",
          reference.scenario,
          reference.kind,
        )
      ),
    );
    const firstTitle = source.indexOf(reference.title);
    if (firstTitle < 0) {
      return yield* regressionSourceError(
        "title_missing",
        reference.scenario,
        reference.kind,
      );
    }
    if (source.indexOf(reference.title, firstTitle + reference.title.length) >= 0) {
      return yield* regressionSourceError(
        "title_ambiguous",
        reference.scenario,
        reference.kind,
      );
    }
    const declarationPrefix = source.slice(Math.max(0, firstTitle - 128), firstTitle);
    if (!declarationPrefix.includes("it.effect")) {
      return yield* regressionSourceError(
        "non_effect_regression",
        reference.scenario,
        reference.kind,
      );
    }
  }

  for (const scenario of AGENTOS_RESILIENCE_SCENARIOS) {
    const original = options.references.filter((reference) =>
      reference.scenario === scenario && reference.kind === "original"
    );
    const heldOut = options.references.filter((reference) =>
      reference.scenario === scenario && reference.kind === "held_out"
    );
    if (original.length === 0 || heldOut.length === 0) {
      return yield* regressionSourceError(
        "scenario_reference_missing",
        scenario,
        null,
      );
    }
    if (original.length !== 1 || heldOut.length !== 1) {
      return yield* regressionSourceError(
        "scenario_reference_duplicate",
        scenario,
        null,
      );
    }
    const originalReference = original[0];
    const heldOutReference = heldOut[0];
    if (originalReference === undefined || heldOutReference === undefined) {
      return yield* regressionSourceError(
        "scenario_reference_missing",
        scenario,
        null,
      );
    }
    if (
      originalReference.path === heldOutReference.path &&
      originalReference.title === heldOutReference.title
    ) {
      return yield* regressionSourceError(
        "original_held_out_reused",
        scenario,
        null,
      );
    }
  }

  return {
    version: 1,
    scenarioCount: AGENTOS_RESILIENCE_SCENARIOS.length,
    referenceCount: options.references.length,
    allEffectNative: true,
  };
});

export const compileAgentOSResilienceVerdict = Effect.fn(
  "agentos.resilience.compileVerdict",
)(function*(input: unknown) {
  const run = yield* Schema.decodeUnknownEffect(AgentOSResilienceRunV1Schema, {
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
  if (!hasMatchingChildEvidence(run)) {
    return yield* gateError("child_evidence_drift", null);
  }
  yield* compileProtocolResilienceVerdict(run.protocol).pipe(
    Effect.mapError(() => gateError("protocol_gate_failed", null)),
  );
  yield* compileAccessResilienceVerdict(run.access).pipe(
    Effect.mapError(() => gateError("access_gate_failed", null)),
  );
  for (const scenario of AGENTOS_RESILIENCE_SCENARIOS) {
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
    if (observation.status === "unobserved") {
      return yield* gateError("scenario_unobserved", scenario);
    }
    if (observation.status === "failed") {
      return yield* gateError("scenario_failed", scenario);
    }
    const expected = agentOSResilienceScenarioDefinition(scenario);
    if (
      observation.outcome !== expected.outcome ||
      observation.failureClass !== expected.failureClass ||
      observation.recovery !== expected.recovery
    ) {
      return yield* gateError("outcome_mismatch", scenario);
    }
    if (
      sourceStrength(observation.source) <
        sourceStrength(expected.minimumSource)
    ) {
      return yield* gateError("proof_source_too_weak", scenario);
    }
    if (
      expected.requiresWorkloadDigests &&
      (observation.workloadSpecDigest === null ||
        observation.renderDigest === null)
    ) {
      return yield* gateError("digest_continuity_missing", scenario);
    }
    if (observation.rollback !== expected.rollback) {
      return yield* gateError("rollback_missing", scenario);
    }
    if (!sameAuthorities(observation.authorities, expected.authorities)) {
      return yield* gateError("authority_violation", scenario);
    }
    if (expected.requiresAttachable && !observation.attachable) {
      return yield* gateError("attachability_missing", scenario);
    }
    if (!observation.observable) {
      return yield* gateError("observability_missing", scenario);
    }
    if (!observation.trace.protected) {
      return yield* gateError("trace_not_protected", scenario);
    }
    if (observation.trace.observedContent.length !== 0) {
      return yield* gateError("content_leak", scenario);
    }
    if (
      observation.trace.metricDimensions.some((dimension) =>
        !AllowedMetricDimensions.some((allowed) => allowed === dimension)
      ) ||
      new Set(observation.trace.metricDimensions).size !==
        observation.trace.metricDimensions.length
    ) {
      return yield* gateError("metric_cardinality_violation", scenario);
    }
  }
  return {
    version: 1,
    eligible: true,
    scenarioCount:
      run.observations.length + run.protocol.observations.length +
      run.access.observations.length,
    revision: run.revision,
    workAuthority: "postgresql",
    sessionAuthority: "provider_native",
  };
});

function regressionTest(
  path: RegressionTest["path"],
  title: RegressionTest["title"],
  issue: RegressionTest["issue"],
): RegressionTest {
  return { issue, path, title };
}

function regressionPair(
  scenario: AgentOSResilienceScenarioId,
  original: RegressionTest,
  heldOut: RegressionTest,
): ReadonlyArray<ResilienceRegressionSourceV1> {
  return [
    {
      version: 1,
      scenario,
      kind: "original",
      issue: original.issue,
      path: original.path,
      title: original.title,
    },
    {
      version: 1,
      scenario,
      kind: "held_out",
      issue: heldOut.issue,
      path: heldOut.path,
      title: heldOut.title,
    },
  ];
}

function definition(
  outcome: AgentOSResilienceScenarioDefinition["outcome"],
  failureClass: AgentOSResilienceScenarioDefinition["failureClass"],
  recovery: AgentOSResilienceScenarioDefinition["recovery"],
  minimumSource: AgentOSResilienceScenarioDefinition["minimumSource"],
  authorities: AgentOSResilienceScenarioDefinition["authorities"],
  requiresAttachable: boolean,
  requiresWorkloadDigests: boolean,
): AgentOSResilienceScenarioDefinition {
  return {
    outcome,
    failureClass,
    recovery,
    rollback: "observed",
    minimumSource,
    authorities,
    requiresAttachable,
    requiresWorkloadDigests,
  };
}

function hasMatchingChildEvidence(run: AgentOSResilienceRunV1) {
  return run.protocol.revision === run.revision &&
    run.access.revision === run.revision &&
    run.protocol.environment.context === run.environment.context &&
    run.access.environment.context === run.environment.context &&
    run.protocol.environment.approvalReference ===
      run.environment.approvalReference &&
    run.access.environment.approvalReference ===
      run.environment.approvalReference &&
    run.protocol.environment.productionEndpointContacted ===
      run.environment.productionEndpointContacted &&
    run.access.environment.productionEndpointContacted ===
      run.environment.productionEndpointContacted &&
    run.protocol.environment.destroyedAfterRun ===
      run.environment.destroyedAfterRun &&
    run.access.environment.destroyedAfterRun ===
      run.environment.destroyedAfterRun &&
    sameImages(run.images, run.protocol.images) &&
    sameImages(run.images, run.access.images);
}

function sameImages(
  left: AgentOSResilienceRunV1["images"],
  right: AgentOSResilienceRunV1["images"],
) {
  return left.length === right.length && left.every((leftImage) =>
    right.some((rightImage) =>
      rightImage.name === leftImage.name &&
      rightImage.digest === leftImage.digest
    )
  );
}

function sameAuthorities(
  left: AgentOSResilienceObservationV1["authorities"],
  right: AgentOSResilienceScenarioDefinition["authorities"],
) {
  return left.work === right.work &&
    left.session === right.session &&
    left.workload === right.workload &&
    left.identity === right.identity;
}

function sourceStrength(source: typeof EvidenceSourceSchema.Type) {
  switch (source) {
    case "effect_fixture":
      return 0;
    case "rendered_resource":
      return 1;
    case "pglite":
      return 2;
    case "disposable_kubernetes":
      return 3;
  }
}

function gateError(
  code: AgentOSResilienceGateError["code"],
  scenario: AgentOSResilienceScenarioId | null,
) {
  return AgentOSResilienceGateError.make({ code, scenario });
}

function regressionSourceError(
  code: ResilienceRegressionSourceError["code"],
  scenario: AgentOSResilienceScenarioId | null,
  kind: ResilienceRegressionSourceV1["kind"] | null,
) {
  return ResilienceRegressionSourceError.make({ code, scenario, kind });
}
