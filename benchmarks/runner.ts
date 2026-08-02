import Ajv2020 from "ajv/dist/2020";
import {
  Clock,
  Crypto,
  Effect,
  FileSystem,
  Path,
  Result,
  Runtime,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

import metricCatalog from "./metrics/catalog.json";
import runPlanJsonSchema from "./schemas/run-plan.schema.json";
import { validateContract } from "./validate.ts";

export type BenchmarkMode = "conformance" | "live" | "offline";
type JsonObject = Record<string, unknown>;

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const JsonFromString = Schema.fromJsonString(Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema);
const isJsonObject = Schema.is(JsonObjectSchema);

const CommandSpecSchema = Schema.Struct({
  interface: Schema.String,
  command: Schema.Array(Schema.String),
});
const NamedVersionSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});
const SubjectSpecSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  source_revision: Schema.String,
  images: Schema.Array(Schema.String),
});
const EnvironmentSpecSchema = Schema.Struct({
  description: Schema.String,
  isolation: Schema.Literals([
    "disposable",
    "production-observation",
    "offline",
  ]),
  approval_reference: Schema.optional(Schema.String),
  permissions: Schema.Array(Schema.String),
  harnesses: Schema.Array(NamedVersionSchema),
  models: Schema.Array(NamedVersionSchema),
  tools: Schema.Array(NamedVersionSchema),
});
const EvaluatorSpecSchema = Schema.Struct({
  kind: Schema.Literals(["deterministic", "model", "human", "hybrid"]),
  name: Schema.String,
  version: Schema.String,
});
const ConformanceExecutionSchema = Schema.Struct({
  collector: CommandSpecSchema,
  trigger: Schema.optional(CommandSpecSchema),
  fault: Schema.optional(Schema.Struct({
    id: Schema.String,
    interface: Schema.String,
    command: Schema.Array(Schema.String),
    approval_reference: Schema.optional(Schema.String),
  })),
});
const LiveExecutionSchema = Schema.Struct({
  completed_work_reference: Schema.String,
  collector: CommandSpecSchema,
});
const OfflineExecutionSchema = Schema.Struct({
  source_bundle_path: Schema.String,
  source_bundle_sha256: Schema.String,
});

export const RunPlanSchema = Schema.Struct({
  schema_version: Schema.Literal("0.1.0"),
  run_id: Schema.String,
  mode: Schema.Literals(["conformance", "live", "offline"]),
  scenario_path: Schema.String,
  subject: SubjectSpecSchema,
  environment: EnvironmentSpecSchema,
  evaluator: EvaluatorSpecSchema,
  execution: Schema.Union([
    ConformanceExecutionSchema,
    LiveExecutionSchema,
    OfflineExecutionSchema,
  ]),
});

export type RunPlan = typeof RunPlanSchema.Type;
type CommandSpec = typeof CommandSpecSchema.Type;
type ConformanceExecution = typeof ConformanceExecutionSchema.Type;
type LiveExecution = typeof LiveExecutionSchema.Type;
type OfflineExecution = typeof OfflineExecutionSchema.Type;

export interface FrozenRun {
  readonly freeze_version: "0.1.0";
  readonly frozen_at: string;
  readonly run_id: string;
  readonly mode: BenchmarkMode;
  readonly scenario: JsonObject;
  readonly scenario_sha256: string;
  readonly rubric_sha256: string;
  readonly subject: RunPlan["subject"];
  readonly environment: RunPlan["environment"];
  readonly evaluator: RunPlan["evaluator"];
  readonly execution: JsonObject;
}

interface CollectedEvidence {
  readonly text: string;
  readonly exactOutput?: Uint8Array;
}

const RunnerErrorCodeSchema = Schema.Literals([
  "invalid_plan",
  "invalid_scenario",
  "mode_boundary",
  "filesystem",
  "encoding",
  "command",
  "invalid_evidence",
  "evidence_binding",
  "source_digest",
  "catalog",
]);

export class BenchmarkRunnerError extends Schema.TaggedErrorClass<BenchmarkRunnerError>()(
  "BenchmarkRunnerError",
  {
    code: RunnerErrorCodeSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

const runnerError = (
  code: typeof RunnerErrorCodeSchema.Type,
  message: string,
  cause?: unknown,
) => BenchmarkRunnerError.make({ code, message, cause });

const validateRunPlanJson = new Ajv2020({ allErrors: true, strict: true })
  .compile(runPlanJsonSchema);
const catalogMetrics = new Map(
  metricCatalog.metrics.map((metric) => [metric.id, metric]),
);
const isConformanceExecution = Schema.is(ConformanceExecutionSchema);
const isLiveExecution = Schema.is(LiveExecutionSchema);
const isOfflineExecution = Schema.is(OfflineExecutionSchema);

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function asValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonObject(value)) return value;
  const canonical: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalize(value[key]);
  }
  return canonical;
}

const encodeJson = Effect.fn("agentos.benchmark.encodeJson")(
  function*(value: unknown) {
    return yield* Schema.encodeEffect(JsonFromString)(value).pipe(
      Effect.mapError((cause) =>
        runnerError("encoding", "Benchmark JSON could not be encoded", cause)
      ),
    );
  },
);

const sha256 = Effect.fn("agentos.benchmark.sha256")(
  function*(value: string | Uint8Array) {
    const crypto = yield* Crypto.Crypto;
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;
    const digest = yield* crypto.digest("SHA-256", bytes).pipe(
      Effect.mapError((cause) =>
        runnerError("encoding", "Benchmark digest could not be computed", cause)
      ),
    );
    return `sha256:${Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  },
);

const jsonSha256 = Effect.fn("agentos.benchmark.jsonSha256")(
  function*(value: unknown) {
    return yield* sha256(yield* encodeJson(canonicalize(value)));
  },
);

const sameValues = Effect.fn("agentos.benchmark.sameValues")(
  function*(left: unknown, right: unknown) {
    const [leftJson, rightJson] = yield* Effect.all([
      encodeJson(canonicalize(left)),
      encodeJson(canonicalize(right)),
    ]);
    return leftJson === rightJson;
  },
);

const ensure = (
  condition: boolean,
  code: typeof RunnerErrorCodeSchema.Type,
  message: string,
) => condition ? Effect.void : Effect.fail(runnerError(code, message));

const assertScenarioMode = Effect.fn("agentos.benchmark.scenarioMode")(
  function*(plan: RunPlan, scenario: JsonObject) {
    if (plan.mode === "offline") {
      return yield* ensure(
        scenario.mode === "conformance" || scenario.mode === "live",
        "mode_boundary",
        "offline mode requires the source scenario's conformance or live mode",
      );
    }
    return yield* ensure(
      scenario.mode === plan.mode,
      "mode_boundary",
      `scenario mode ${String(scenario.mode)} does not match run mode ${plan.mode}`,
    );
  },
);

const assertConformance = Effect.fn("agentos.benchmark.conformanceBoundary")(
  function*(
    plan: RunPlan,
    scenario: JsonObject,
    execution: ConformanceExecution,
  ) {
    yield* ensure(
      plan.environment.isolation === "disposable",
      "mode_boundary",
      "conformance mode requires a disposable environment",
    );
    yield* ensure(
      plan.environment.approval_reference !== undefined,
      "mode_boundary",
      "conformance mode requires a disposable-environment approval reference",
    );
    const declaredFaults = asObjects(scenario.faults);
    if (declaredFaults.length === 0) {
      return yield* ensure(
        execution.fault === undefined,
        "mode_boundary",
        "this scenario declares no injectable fault",
      );
    }
    yield* ensure(
      execution.fault !== undefined && execution.trigger !== undefined,
      "mode_boundary",
      "a faulted conformance scenario requires trigger and fault commands",
    );
    const faultExecution = execution.fault;
    if (faultExecution === undefined) return;
    const fault = declaredFaults.find((candidate) =>
      candidate.id === faultExecution.id
    );
    yield* ensure(
      fault !== undefined,
      "mode_boundary",
      `fault ${faultExecution.id} is not declared by the scenario`,
    );
    yield* ensure(
      fault?.approval_required !== true ||
        faultExecution.approval_reference !== undefined,
      "mode_boundary",
      `fault ${faultExecution.id} requires an approval reference`,
    );
  },
);

const assertModeBoundary = Effect.fn("agentos.benchmark.modeBoundary")(
  function*(plan: RunPlan, scenario: JsonObject) {
    yield* assertScenarioMode(plan, scenario);
    if (plan.mode === "conformance") {
      if (!isConformanceExecution(plan.execution)) {
        return yield* runnerError(
          "mode_boundary",
          "conformance mode requires conformance execution interfaces",
        );
      }
      return yield* assertConformance(plan, scenario, plan.execution);
    }
    if (plan.mode === "live") {
      yield* ensure(
        isLiveExecution(plan.execution),
        "mode_boundary",
        "live mode requires completed-work collection",
      );
      return yield* ensure(
        plan.environment.isolation === "production-observation",
        "mode_boundary",
        "live mode requires production-observation isolation",
      );
    }
    yield* ensure(
      isOfflineExecution(plan.execution),
      "mode_boundary",
      "offline mode requires immutable source evidence",
    );
    return yield* ensure(
      plan.environment.isolation === "offline",
      "mode_boundary",
      "offline mode requires offline isolation",
    );
  },
);

export const parseRunPlan = Effect.fn("agentos.benchmark.parseRunPlan")(
  function*(value: unknown) {
    if (!validateRunPlanJson(value)) {
      return yield* runnerError("invalid_plan", "invalid run plan");
    }
    return yield* Schema.decodeUnknownEffect(RunPlanSchema)(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) =>
        runnerError("invalid_plan", "invalid run plan", cause)
      ),
    );
  },
);

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
);

export const freezeRun = Effect.fn("agentos.benchmark.freezeRun")(
  function*(plan: RunPlan, runDirectory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const scenario = yield* fileSystem.readFileString(plan.scenario_path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonObjectFromString)),
      Effect.mapError((cause) =>
        runnerError(
          "invalid_scenario",
          `could not decode scenario: ${plan.scenario_path}`,
          cause,
        )
      ),
    );
    const validation = validateContract("scenario", scenario);
    if (!validation.valid) {
      return yield* runnerError("invalid_scenario", "invalid scenario");
    }
    yield* assertModeBoundary(plan, scenario);

    const [scenarioDigest, rubricDigest, execution, frozenAt] =
      yield* Effect.all([
        jsonSha256(scenario),
        jsonSha256(scenario.rubric),
        Schema.decodeUnknownEffect(JsonObjectSchema)(plan.execution).pipe(
          Effect.mapError((cause) =>
            runnerError("encoding", "execution could not be frozen", cause)
          ),
        ),
        nowIso,
      ]);
    const frozen: FrozenRun = {
      freeze_version: "0.1.0",
      frozen_at: frozenAt,
      run_id: plan.run_id,
      mode: plan.mode,
      scenario,
      scenario_sha256: scenarioDigest,
      rubric_sha256: rubricDigest,
      subject: structuredClone(plan.subject),
      environment: structuredClone(plan.environment),
      evaluator: structuredClone(plan.evaluator),
      execution,
    };
    const encoded = yield* encodeJson(frozen);
    yield* fileSystem.makeDirectory(runDirectory, { recursive: false }).pipe(
      Effect.andThen(fileSystem.writeFileString(
        paths.join(runDirectory, "frozen-run.json"),
        `${encoded}\n`,
        { flag: "wx" },
      )),
      Effect.mapError((cause) =>
        runnerError(
          "filesystem",
          `could not freeze benchmark run: ${runDirectory}`,
          cause,
        )
      ),
    );
    return frozen;
  },
);

const runCommand = Effect.fn("agentos.benchmark.runCommand")(
  function*(spec: CommandSpec) {
    const command = spec.command[0];
    if (command === undefined) {
      return yield* runnerError(
        "command",
        `${spec.interface} command is empty`,
      );
    }
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make(command, spec.command.slice(1), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(
        Effect.mapError((cause) =>
          runnerError(
            "command",
            `${spec.interface} command could not start`,
            cause,
          )
        ),
      );
      const [exitCode, stdout] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError((cause) =>
          runnerError(
            "command",
            `${spec.interface} command output could not be collected`,
            cause,
          )
        ),
      );
      if (exitCode !== 0) {
        return yield* runnerError(
          "command",
          `${spec.interface} command failed with exit ${exitCode}`,
        );
      }
      return stdout;
    }));
  },
);

const assertEvidenceBinding = Effect.fn(
  "agentos.benchmark.assertEvidenceBinding",
)(function*(frozen: FrozenRun, evidence: JsonObject) {
  const scenario = asObject(evidence.scenario);
  const evidenceSubject = asObject(evidence.subject);
  const environment = asObject(evidence.environment);
  const evaluator = asObject(evidence.evaluator);
  const frozenRubric = asObject(frozen.scenario.rubric);
  if (
    scenario === undefined ||
    evidenceSubject === undefined ||
    environment === undefined ||
    evaluator === undefined ||
    frozenRubric === undefined
  ) {
    return yield* runnerError(
      "evidence_binding",
      "evidence binding objects are missing",
    );
  }
  if (frozen.mode === "offline") {
    yield* ensure(
      evidence.mode === frozen.scenario.mode,
      "evidence_binding",
      "offline source evidence mode does not match its frozen scenario",
    );
  } else {
    yield* ensure(
      evidence.run_id === frozen.run_id,
      "evidence_binding",
      "evidence run_id changed after freeze",
    );
    yield* ensure(
      evidence.mode === frozen.mode,
      "evidence_binding",
      "evidence mode changed after freeze",
    );
  }
  yield* ensure(
    scenario.id === frozen.scenario.id &&
      scenario.version === frozen.scenario.version,
    "evidence_binding",
    "evidence scenario changed after freeze",
  );
  const subjectValuesMatch = yield* sameValues(
    evidenceSubject.images,
    frozen.subject.images,
  );
  yield* ensure(
    evidenceSubject.name === frozen.subject.name &&
      evidenceSubject.version === frozen.subject.version &&
      evidenceSubject.source_revision === frozen.subject.source_revision &&
      subjectValuesMatch,
    "evidence_binding",
    "evidence subject changed after freeze",
  );
  const [permissionsMatch, harnessesMatch, modelsMatch, toolsMatch] =
    yield* Effect.all([
      sameValues(environment.permissions, frozen.environment.permissions),
      sameValues(environment.harnesses, frozen.environment.harnesses),
      sameValues(environment.models, frozen.environment.models),
      sameValues(environment.tools, frozen.environment.tools),
    ]);
  yield* ensure(
    environment.description === frozen.environment.description &&
      permissionsMatch &&
      harnessesMatch &&
      modelsMatch &&
      toolsMatch,
    "evidence_binding",
    "evidence environment changed after freeze",
  );
  yield* ensure(
    evaluator.rubric_version === frozenRubric.version,
    "evidence_binding",
    "evidence evaluator or rubric changed after freeze",
  );
  yield* ensure(
    frozen.mode === "offline" ||
      (evaluator.name === frozen.evaluator.name &&
        evaluator.version === frozen.evaluator.version &&
        evaluator.kind === frozen.evaluator.kind),
    "evidence_binding",
    "evidence evaluator or rubric changed after freeze",
  );
});

const parseEvidence = Effect.fn("agentos.benchmark.parseEvidence")(
  function*(text: string, frozen: FrozenRun) {
    const evidence = yield* Schema.decodeUnknownEffect(JsonObjectFromString)(
      text,
    ).pipe(
      Effect.mapError((cause) =>
        runnerError(
          "invalid_evidence",
          "collector returned malformed evidence JSON",
          cause,
        )
      ),
    );
    const validation = validateContract("evidence", evidence);
    if (!validation.valid) {
      return yield* runnerError("invalid_evidence", "invalid evidence");
    }
    yield* assertEvidenceBinding(frozen, evidence);
    return evidence;
  },
);

const incompleteEvidence = Effect.fn("agentos.benchmark.incompleteEvidence")(
  function*(
    frozen: FrozenRun,
    startedAt: string,
    error: BenchmarkRunnerError,
  ) {
    const scenario = frozen.scenario;
    const rubric = asObject(scenario.rubric);
    if (rubric === undefined) {
      return yield* runnerError(
        "invalid_scenario",
        "frozen scenario rubric is missing",
      );
    }
    const explanation = error.message;
    const eventId = "benchmark-runner-failure";
    const metrics = yield* Effect.forEach(
      asValues(scenario.metrics).map(String),
      (id) => {
        const definition = catalogMetrics.get(id);
        return definition === undefined
          ? Effect.fail(runnerError(
            "catalog",
            `scenario metric ${id} is not in the catalog`,
          ))
          : Effect.succeed({
            id,
            state: "unobserved",
            unit: definition.unit,
            reason: `The evaluator did not complete: ${explanation}`,
            source_event_ids: [eventId],
          });
      },
    );
    const [createdAt, endedAt, eventAt] = yield* Effect.all([
      nowIso,
      nowIso,
      nowIso,
    ]);
    return {
      schema_version: "0.1.0",
      run_id: frozen.run_id,
      created_at: createdAt,
      mode: frozen.mode,
      scenario: { id: scenario.id, version: scenario.version },
      subject: frozen.subject,
      environment: {
        description: frozen.environment.description,
        permissions: frozen.environment.permissions,
        harnesses: frozen.environment.harnesses,
        models: frozen.environment.models,
        tools: frozen.environment.tools,
      },
      timing: { started_at: startedAt, ended_at: endedAt },
      outcome: {
        status: "incomplete",
        summary: `The evaluator did not complete: ${explanation}`,
        acceptance_criteria: asObjects(scenario.acceptance_criteria).map(
          (criterion) => ({
            id: criterion.id,
            status: "unobserved",
            explanation:
              "The evaluator failed before this criterion could be verified.",
            evidence_event_ids: [eventId],
          }),
        ),
      },
      events: [{
        id: eventId,
        at: eventAt,
        actor: "evaluator",
        type: "evaluator-failure",
        authority: "benchmark-runner",
        summary: explanation,
      }],
      metrics,
      gates: asObjects(rubric.mechanical_gates).map((gate) => ({
        id: gate.id,
        status: "unobserved",
        explanation: "The evaluator failed before this gate could be verified.",
        evidence_event_ids: [eventId],
      })),
      artifacts: [],
      redactions: [],
      evaluator: { ...frozen.evaluator, rubric_version: rubric.version },
    } satisfies JsonObject;
  },
);

const collectEvidence = Effect.fn("agentos.benchmark.collectEvidence")(
  function*(frozen: FrozenRun) {
    const fileSystem = yield* FileSystem.FileSystem;
    if (frozen.mode === "offline") {
      if (!isOfflineExecution(frozen.execution)) {
        return yield* runnerError(
          "mode_boundary",
          "offline execution is invalid after freeze",
        );
      }
      const source = yield* fileSystem.readFile(
        frozen.execution.source_bundle_path,
      ).pipe(
        Effect.mapError((cause) =>
          runnerError("filesystem", "offline source bundle could not be read", cause)
        ),
      );
      yield* ensure(
        (yield* sha256(source)) === frozen.execution.source_bundle_sha256,
        "source_digest",
        "offline source bundle digest does not match its frozen digest",
      );
      return {
        text: new TextDecoder().decode(source),
        exactOutput: source,
      } satisfies CollectedEvidence;
    }
    if (frozen.mode === "live") {
      if (!isLiveExecution(frozen.execution)) {
        return yield* runnerError(
          "mode_boundary",
          "live execution is invalid after freeze",
        );
      }
      return {
        text: yield* runCommand(frozen.execution.collector),
      } satisfies CollectedEvidence;
    }
    if (!isConformanceExecution(frozen.execution)) {
      return yield* runnerError(
        "mode_boundary",
        "conformance execution is invalid after freeze",
      );
    }
    if (frozen.execution.trigger !== undefined) {
      yield* runCommand(frozen.execution.trigger);
    }
    if (frozen.execution.fault !== undefined) {
      yield* runCommand(frozen.execution.fault);
    }
    return {
      text: yield* runCommand(frozen.execution.collector),
    } satisfies CollectedEvidence;
  },
);

export const runAttempt = Effect.fn("agentos.benchmark.runAttempt")(
  function*(plan: RunPlan, runDirectory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const frozen = yield* freezeRun(plan, runDirectory);
    const startedAt = yield* nowIso;
    const collected = yield* collectEvidence(frozen).pipe(
      Effect.flatMap((evidence) =>
        parseEvidence(evidence.text, frozen).pipe(
          Effect.map((parsed) => ({ evidence, parsed })),
        )
      ),
      Effect.result,
    );

    let evidence: JsonObject;
    let output: string | Uint8Array;
    if (Result.isSuccess(collected)) {
      evidence = collected.success.parsed;
      output = collected.success.evidence.exactOutput ??
        `${yield* encodeJson(evidence)}\n`;
    } else {
      evidence = yield* incompleteEvidence(
        frozen,
        startedAt,
        collected.failure,
      );
      const validation = validateContract("evidence", evidence);
      if (!validation.valid) {
        return yield* runnerError(
          "invalid_evidence",
          "runner produced invalid failure evidence",
        );
      }
      output = `${yield* encodeJson(evidence)}\n`;
    }
    const evidencePath = paths.join(runDirectory, "evidence.json");
    yield* (typeof output === "string"
      ? fileSystem.writeFileString(evidencePath, output, { flag: "wx" })
      : fileSystem.writeFile(evidencePath, output, { flag: "wx" })).pipe(
        Effect.mapError((cause) =>
          runnerError(
            "filesystem",
            `could not write benchmark evidence: ${evidencePath}`,
            cause,
          )
        ),
      );
    return evidence;
  },
);
