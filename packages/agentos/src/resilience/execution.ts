import { Effect, Option, Path, Schema } from "effect";

import {
  ACCESS_RESILIENCE_REGRESSION_SOURCES,
  ACCESS_RESILIENCE_SCENARIOS,
  accessResilienceScenarioDefinition,
  compileAccessResilienceVerdict,
  verifyAccessResilienceRegressionSources,
  type AccessResilienceObservationV1,
  type AccessResilienceRunV1,
  type AccessResilienceScenarioId,
} from "../access/resilience-conformance.ts";
import {
  AGENTOS_RESILIENCE_SCENARIOS,
  RESILIENCE_REGRESSION_SOURCES,
  agentOSResilienceScenarioDefinition,
  compileAgentOSResilienceVerdict,
  verifyResilienceRegressionSources,
  type AgentOSResilienceObservationV1,
  type AgentOSResilienceRunV1,
} from "./conformance.ts";
import {
  DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS,
  PROTOCOL_RESILIENCE_SCENARIOS,
  protocolResilienceScenarioDefinition,
  type ProtocolResilienceObservationV1,
  type ProtocolResilienceRunV1,
  type ProtocolResilienceScenarioId,
} from "../protocol/resilience-conformance.ts";

const ExecutionReferenceSchema = Schema.Struct({
  path: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(256),
      Schema.isPattern(
        /^(?:benchmarks|clis|database|packages|services|tooling)\/[0-9A-Za-z._/-]+\.effect\.test\.ts$/,
      ),
    ),
  ),
  title: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});

const VitestAssertionSchema = Schema.Struct({
  title: Schema.String,
  fullName: Schema.String,
  status: Schema.String,
  failureMessages: Schema.Array(Schema.String),
});

const VitestTestResultSchema = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
  ),
  status: Schema.String,
  assertionResults: Schema.Array(VitestAssertionSchema),
});

const VitestReportSchema = Schema.Struct({
  success: Schema.Boolean,
  numFailedTests: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  testResults: Schema.Array(VitestTestResultSchema),
});

const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
);
const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const RevisionSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
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
  productionEndpointContacted: Schema.Literal(false),
  destroyedAfterRun: Schema.Literal(true),
});

export const WorkloadHardGateEvidenceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  context: DisposableEnvironmentSchema.fields.context,
  approvalReference: DisposableEnvironmentSchema.fields.approvalReference,
  persistentSpecDigest: DigestSchema,
  persistentRenderDigest: DigestSchema,
  interactiveSpecDigest: DigestSchema,
  interactiveRenderDigest: DigestSchema,
  matePodReplaced: Schema.Literal(true),
  matePvcRetained: Schema.Literal(true),
  mateWorktreeRetained: Schema.Literal(true),
  crewmatePodReplaced: Schema.Literal(true),
  crewmatePvcRetained: Schema.Literal(true),
  retainedPvcNodeAffinity: Schema.Literal(true),
  projectedSecretTemplateMode: Schema.Literal("0440"),
  projectedSecretObservedMode: Schema.Literal("0640"),
  projectedSecretObservedOwner: Schema.Literal("65535:65535"),
  projectedSecretWriteDenied: Schema.Literal(true),
  cpuQuotaDenied: Schema.Literal(true),
  memoryQuotaDenied: Schema.Literal(true),
  namespacesDeleted: Schema.Literal(true),
  productionEndpointContacted: Schema.Literal(false),
});

export const ProtocolHardGateEvidenceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  context: DisposableEnvironmentSchema.fields.context,
  approvalReference: DisposableEnvironmentSchema.fields.approvalReference,
  revocationMillis: NonNegativeIntegerSchema,
  parentChildAllowed: Schema.Literal(true),
  siblingDenied: Schema.Literal(true),
  crossDomainDenied: Schema.Literal(true),
  expiredIdentityDenied: Schema.Literal(true),
  piPodReplaced: Schema.Literal(true),
  piNativeSessionResumed: Schema.Literal(true),
  codexPodReplaced: Schema.Literal(true),
  codexNativeSessionResumed: Schema.Literal(true),
  namespacesDeleted: Schema.Literal(true),
  productionEndpointContacted: Schema.Literal(false),
});

export const AccessHardGateEvidenceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  context: DisposableEnvironmentSchema.fields.context,
  approvalReference: DisposableEnvironmentSchema.fields.approvalReference,
  revocationMillis: NonNegativeIntegerSchema,
  hotReloadMillis: NonNegativeIntegerSchema,
  loadAttempts: NonNegativeIntegerSchema.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(16)),
  ),
  wrongAudienceDenied: Schema.Literal(true),
  stalePodUidDenied: Schema.Literal(true),
  deletedPodDenied: Schema.Literal(true),
  staleServiceAccountUidDenied: Schema.Literal(true),
  deletedServiceAccountDenied: Schema.Literal(true),
  projectedTokensRotated: Schema.Literal(true),
  unrelatedSubjectAllowed: Schema.Literal(true),
  ordinaryInternetAllowed: Schema.Literal(true),
  rollingUpgradeObserved: Schema.Literal(true),
  failedRevisionWithheld: Schema.Literal(true),
  rollingRollbackObserved: Schema.Literal(true),
  unrelatedWorkloadAvailableDuringRollback: Schema.Literal(true),
  namespacesDeleted: Schema.Literal(true),
  productionEndpointContacted: Schema.Literal(false),
});

const TestExecutionInputSchema = Schema.Struct({
  repositoryRoot: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  ),
  hardGate: Schema.Literal(true),
  report: VitestReportSchema,
  references: Schema.Array(ExecutionReferenceSchema).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});

const ExecutedVerdictInputSchema = Schema.Struct({
  repositoryRoot: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  ),
  hardGate: Schema.Literal(true),
  revision: RevisionSchema,
  environment: DisposableEnvironmentSchema,
  images: Schema.Array(ImageSchema).pipe(
    Schema.check(Schema.isMinLength(5), Schema.isMaxLength(5)),
  ),
  workloadSpecDigest: DigestSchema,
  renderDigest: DigestSchema,
  protocolRevocationMillis: NonNegativeIntegerSchema,
  accessEvidence: AccessHardGateEvidenceV1Schema,
  report: Schema.Unknown,
});

const HardGateArtifactInputSchema = Schema.Struct({
  hardGate: Schema.Boolean,
  path: Schema.NullOr(Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1_024),
      Schema.isPattern(/^\//),
    ),
  )),
});

const HardGateRevisionInputSchema = Schema.Struct({
  beforeRevision: RevisionSchema,
  afterRevision: RevisionSchema,
  porcelain: Schema.String.pipe(Schema.check(Schema.isMaxLength(16_384))),
  approvalReference: DisposableEnvironmentSchema.fields.approvalReference,
});

const DisposableProofInputSchema = Schema.Struct({
  hardGate: Schema.Boolean,
  context: Schema.NullOr(Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^(?:kind|vcluster)-[a-z0-9-]+$/),
    ),
  )),
  approvalReference: Schema.NullOr(Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^approval:[0-9A-Za-z._:-]+$/),
    ),
  )),
});

const ResilienceExecutionErrorCodeSchema = Schema.Literals([
  "invalid_contract",
  "hard_gate_configuration_missing",
  "test_run_failed",
  "test_file_outside_repository",
  "assertion_missing",
  "assertion_duplicate",
  "assertion_not_passed",
  "working_tree_dirty",
  "revision_approval_mismatch",
  "revision_changed",
  "hard_gate_artifact_missing",
]);

export class ResilienceExecutionError extends Schema.TaggedErrorClass<ResilienceExecutionError>()(
  "ResilienceExecutionError",
  {
    code: ResilienceExecutionErrorCodeSchema,
    path: Schema.NullOr(Schema.String),
    title: Schema.NullOr(Schema.String),
  },
) {}

const executionError = (
  code: typeof ResilienceExecutionErrorCodeSchema.Type,
  path: string | null = null,
  title: string | null = null,
) => ResilienceExecutionError.make({ code, path, title });

const executionControlReferences: ReadonlyArray<
  typeof ExecutionReferenceSchema.Type
> = [
  {
    path:
      "packages/agentos/src/access/tests/resilience-conformance.effect.test.ts",
    title:
      "accepts the complete identity, policy, failure, native-client, and privacy matrix",
  },
  {
    path: "packages/agentos/src/access/tests/contracts.effect.test.ts",
    title: "keeps profile, ceiling, binding, and audit records payload-free",
  },
  {
    path: "packages/agentos/src/telemetry/tests/contract.effect.test.ts",
    title: "defines owned structured log and audit events with exact attributes",
  },
  {
    path: "packages/agentos/src/telemetry/tests/contract.effect.test.ts",
    title: "rejects every seeded forbidden field from every supported signal",
  },
  {
    path:
      "packages/agentos/runtime/hard-gate/resilience-hard-gate-sentinel.effect.test.ts",
    title: "requires explicit hard-gate mode",
  },
  {
    path:
      "packages/agentos/src/protocol/tests/resilience-conformance.effect.test.ts",
    title:
      "accepts the complete disposable and deterministic protocol matrix",
  },
  {
    path:
      "packages/agentos/src/resilience/tests/conformance.effect.test.ts",
    title: "accepts the complete exact-revision Effect evidence matrix",
  },
  {
    path:
      "packages/agentos/src/resilience/tests/source-verification.effect.test.ts",
    title: "binds every scenario to distinct existing Effect regressions",
  },
];

export const AGENTOS_RESILIENCE_EXECUTION_REFERENCES: ReadonlyArray<
  typeof ExecutionReferenceSchema.Type
> = [
  ...RESILIENCE_REGRESSION_SOURCES.map(({ path, title }) => ({ path, title })),
  ...ACCESS_RESILIENCE_REGRESSION_SOURCES.map(({ path, title }) => ({
    path,
    title,
  })),
  ...executionControlReferences,
].filter((reference, index, references) =>
  references.findIndex((candidate) =>
    candidate.path === reference.path && candidate.title === reference.title
  ) === index
);

export const resolveDisposableProofOptions = Effect.fn(
  "agentos.resilience.resolveDisposableProofOptions",
)(function*(input: unknown) {
  const options = yield* Schema.decodeUnknownEffect(
    DisposableProofInputSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  if (
    options.context === null ||
    options.approvalReference === null
  ) {
    if (options.hardGate) {
      return yield* executionError("hard_gate_configuration_missing");
    }
    return Option.none();
  }
  return Option.some({
    context: options.context,
    approvalReference: options.approvalReference,
  });
});

export const resolveHardGateArtifactPath = Effect.fn(
  "agentos.resilience.resolveHardGateArtifactPath",
)(function*(input: unknown) {
  const artifact = yield* Schema.decodeUnknownEffect(
    HardGateArtifactInputSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  if (artifact.path !== null) return Option.some(artifact.path);
  if (artifact.hardGate) {
    return yield* executionError("hard_gate_artifact_missing");
  }
  return Option.none();
});

export const validateHardGateRevision = Effect.fn(
  "agentos.resilience.validateHardGateRevision",
)(function*(input: unknown) {
  const state = yield* Schema.decodeUnknownEffect(
    HardGateRevisionInputSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  if (state.porcelain.trim() !== "") {
    return yield* executionError("working_tree_dirty");
  }
  if (!state.approvalReference.endsWith(state.beforeRevision)) {
    return yield* executionError("revision_approval_mismatch");
  }
  if (state.afterRevision !== state.beforeRevision) {
    return yield* executionError("revision_changed");
  }
  return state.beforeRevision;
});

function isRepositoryPath(relative: string, separator: string) {
  return relative !== ".." &&
    !relative.startsWith(`..${separator}`) &&
    !relative.startsWith("/");
}

export const verifyResilienceTestExecution = Effect.fn(
  "agentos.resilience.verifyTestExecution",
)(function*(input: unknown) {
  const proof = yield* Schema.decodeUnknownEffect(TestExecutionInputSchema)(
    input,
  ).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  if (
    !proof.report.success ||
    proof.report.numFailedTests !== 0 ||
    proof.report.testResults.some((result) => result.status === "failed")
  ) {
    return yield* executionError("test_run_failed");
  }

  const paths = yield* Path.Path;
  const repositoryRoot = paths.resolve(proof.repositoryRoot);
  const results = yield* Effect.forEach(proof.report.testResults, (result) => {
    const resolved = paths.resolve(result.name);
    const relative = paths.relative(repositoryRoot, resolved);
    if (!isRepositoryPath(relative, paths.sep)) {
      return Effect.fail(executionError(
        "test_file_outside_repository",
        result.name,
      ));
    }
    return Effect.succeed({ ...result, relative });
  });

  for (const reference of proof.references) {
    const assertions = results
      .filter((result) => result.relative === reference.path)
      .flatMap((result) =>
        result.assertionResults.filter((assertion) =>
          assertion.title === reference.title
        )
      );
    if (assertions.length === 0) {
      return yield* executionError(
        "assertion_missing",
        reference.path,
        reference.title,
      );
    }
    if (assertions.length !== 1) {
      return yield* executionError(
        "assertion_duplicate",
        reference.path,
        reference.title,
      );
    }
    if (assertions[0]?.status !== "passed") {
      return yield* executionError(
        "assertion_not_passed",
        reference.path,
        reference.title,
      );
    }
  }

  return {
    version: 1,
    hardGate: true,
    passedAssertionCount: new Set(
      proof.references.map(({ path, title }) => `${path}\u0000${title}`),
    ).size,
    referencedFileCount: new Set(
      proof.references.map(({ path }) => path),
    ).size,
  };
});

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";

function protocolObservation(
  scenario: ProtocolResilienceScenarioId,
  revocationMillis: number,
): ProtocolResilienceObservationV1 {
  const definition = protocolResilienceScenarioDefinition(scenario);
  const protocol = scenario.startsWith("acp.") ? "acp" : "a2a";
  const revocation = [
    "a2a.denied_inactive_assignment",
    "a2a.denied_revoked_profile",
    "a2a.denied_expired_identity",
  ].includes(scenario);
  return {
    version: 1,
    scenario,
    protocol,
    source: DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS.some((candidate) =>
        candidate === scenario
      )
      ? "disposable_kubernetes"
      : "effect_fixture",
    observed: definition.expected,
    failureClass: definition.failureClass,
    recovery: definition.recovery,
    elapsedMillis: 0,
    revocationMillis: revocation ? revocationMillis : null,
    durableMutations: {
      tasks: 0,
      assignments: 0,
      inbox: 0,
      executions: 0,
      reports: 0,
    },
    custody: {
      sessionAuthority: protocol === "acp" ? "provider_native" : "not_applicable",
      nativeSessionAvailable: protocol === "acp" ? true : null,
      maximumActiveWriters: protocol === "acp" ? 1 : 0,
      herdrAttachable: true,
      canonicalWorkAuthority: "postgresql",
    },
    trace: {
      protected: true,
      agentId: AgentId,
      assignmentId: AssignmentId,
      workloadId: "hard-gate-workload",
      gatewayId: protocol === "a2a" ? "hard-gate-request" : null,
      protocolId: `hard-gate-${scenario.replaceAll(".", "-")}`,
      adapterId: "hard-gate-adapter",
      recoveryId: definition.recovery === "not_required"
        ? null
        : "hard-gate-recovery",
    },
    metricDimensions: [
      "protocol",
      "operation",
      "outcome",
      "failure_class",
      "recovery",
    ],
    observedContent: [],
  };
}

function agentOSObservation(
  scenario: typeof AGENTOS_RESILIENCE_SCENARIOS[number],
  workloadSpecDigest: string,
  renderDigest: string,
): AgentOSResilienceObservationV1 {
  const definition = agentOSResilienceScenarioDefinition(scenario);
  return {
    version: 1,
    scenario,
    source: definition.minimumSource,
    status: "observed",
    outcome: definition.outcome,
    failureClass: definition.failureClass,
    recovery: definition.recovery,
    rollback: definition.rollback,
    authorities: definition.authorities,
    attachable: definition.requiresAttachable,
    observable: true,
    workloadSpecDigest: definition.requiresWorkloadDigests
      ? workloadSpecDigest
      : null,
    renderDigest: definition.requiresWorkloadDigests ? renderDigest : null,
    trace: {
      protected: true,
      metricDimensions: [
        "component",
        "operation",
        "outcome",
        "failure_class",
        "recovery",
      ],
      observedContent: [],
    },
  };
}

function accessObservation(
  scenario: AccessResilienceScenarioId,
  evidence: typeof AccessHardGateEvidenceV1Schema.Type,
): AccessResilienceObservationV1 {
  const expected = accessResilienceScenarioDefinition(scenario);
  const attempts = expected.requiresLoad ? evidence.loadAttempts : 1;
  const allowed = ["allowed", "completed", "bypassed"].includes(
    expected.outcome,
  );
  return {
    version: 1,
    scenario,
    source: expected.minimumSource,
    status: "observed",
    outcome: expected.outcome,
    failureClass: expected.failureClass,
    recovery: expected.recovery,
    elapsedMillis: 0,
    revocationMillis: expected.requiresRevocationSlo
      ? evidence.revocationMillis
      : null,
    hotReloadMillis: expected.requiresHotReloadSlo
      ? evidence.hotReloadMillis
      : null,
    load: {
      attempts,
      allowed: allowed ? attempts : 0,
      denied: allowed ? 0 : attempts,
      providerForwards: expected.providerForwardExpected ? attempts : 0,
      settlements: expected.settlementExpected ? attempts : 0,
    },
    enforcement: {
      providerAdapterReached: expected.providerForwardExpected,
      credentialReleased: expected.credentialReleaseExpected,
      unrelatedSubjectAllowed: expected.requiresUnrelatedContinuity
        ? evidence.unrelatedSubjectAllowed
        : null,
      ordinaryInternetAllowed: expected.requiresInternetContinuity
        ? evidence.ordinaryInternetAllowed
        : null,
    },
    native: {
      client: expected.nativeClient,
      projectedTokenReread: expected.nativeClient === "none" ? null : true,
      persistedLogin: expected.nativeClient === "none" ? null : false,
      statusPreserved: expected.requiresNativeSemantics ? true : null,
      streamPreserved: expected.requiresNativeSemantics ? true : null,
      stderrPreserved: expected.requiresNativeSemantics ? true : null,
      exitCodePreserved: expected.requiresNativeSemantics ? true : null,
    },
    audit: {
      complete: true,
      protected: true,
      eventCount: 1,
      metricDimensions: [
        "operation",
        "outcome",
        "failure_class",
        "dependency",
        "credential_outcome",
      ],
      observedContent: [],
    },
  };
}

export const compileExecutedAgentOSResilienceVerdict = Effect.fn(
  "agentos.resilience.compileExecutedVerdict",
)(function*(input: unknown) {
  const metadata = yield* Schema.decodeUnknownEffect(
    ExecutedVerdictInputSchema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  yield* verifyResilienceRegressionSources({
    repositoryRoot: metadata.repositoryRoot,
    references: RESILIENCE_REGRESSION_SOURCES,
  });
  yield* verifyAccessResilienceRegressionSources({
    repositoryRoot: metadata.repositoryRoot,
    references: ACCESS_RESILIENCE_REGRESSION_SOURCES,
  }).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  const execution = yield* verifyResilienceTestExecution({
    repositoryRoot: metadata.repositoryRoot,
    hardGate: true,
    report: metadata.report,
    references: AGENTOS_RESILIENCE_EXECUTION_REFERENCES,
  });
  const protocol: ProtocolResilienceRunV1 = {
    version: 1,
    revision: metadata.revision,
    environment: metadata.environment,
    images: metadata.images,
    observations: PROTOCOL_RESILIENCE_SCENARIOS.map((scenario) =>
      protocolObservation(scenario, metadata.protocolRevocationMillis)
    ),
  };
  const access: AccessResilienceRunV1 = {
    version: 1,
    revision: metadata.revision,
    environment: metadata.environment,
    images: metadata.images,
    observations: ACCESS_RESILIENCE_SCENARIOS.map((scenario) =>
      accessObservation(scenario, metadata.accessEvidence)
    ),
  };
  const run: AgentOSResilienceRunV1 = {
    version: 1,
    revision: metadata.revision,
    environment: metadata.environment,
    images: metadata.images,
    observations: AGENTOS_RESILIENCE_SCENARIOS.map((scenario) =>
      agentOSObservation(
        scenario,
        metadata.workloadSpecDigest,
        metadata.renderDigest,
      )
    ),
    protocol,
    access,
  };
  const accessVerdict = yield* compileAccessResilienceVerdict(access).pipe(
    Effect.mapError(() => executionError("invalid_contract")),
  );
  const verdict = yield* compileAgentOSResilienceVerdict(run);
  return { version: 1, execution, access: accessVerdict, verdict };
});
