import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import metricCatalog from "./metrics/catalog.json";
import runPlanSchema from "./schemas/run-plan.schema.json";
import { validateContract } from "./validate";

export type BenchmarkMode = "conformance" | "live" | "offline";
type JsonObject = Record<string, unknown>;

interface CommandSpec {
  interface: string;
  command: string[];
}

interface SubjectSpec {
  name: string;
  version: string;
  source_revision: string;
  images: string[];
}

interface EnvironmentSpec {
  description: string;
  isolation: "disposable" | "production-observation" | "offline";
  approval_reference?: string;
  permissions: string[];
  harnesses: Array<{ name: string; version: string }>;
  models: Array<{ name: string; version: string }>;
  tools: Array<{ name: string; version: string }>;
}

interface EvaluatorSpec {
  kind: "deterministic" | "model" | "human" | "hybrid";
  name: string;
  version: string;
}

interface ConformanceExecution {
  collector: CommandSpec;
  trigger?: CommandSpec;
  fault?: CommandSpec & { id: string; approval_reference?: string };
}

interface LiveExecution {
  completed_work_reference: string;
  collector: CommandSpec;
}

interface OfflineExecution {
  source_bundle_path: string;
  source_bundle_sha256: string;
}

export interface RunPlan {
  schema_version: "0.1.0";
  run_id: string;
  mode: BenchmarkMode;
  scenario_path: string;
  subject: SubjectSpec;
  environment: EnvironmentSpec;
  evaluator: EvaluatorSpec;
  execution: ConformanceExecution | LiveExecution | OfflineExecution;
}

export interface FrozenRun {
  freeze_version: "0.1.0";
  frozen_at: string;
  run_id: string;
  mode: BenchmarkMode;
  scenario: JsonObject;
  scenario_sha256: string;
  rubric_sha256: string;
  subject: SubjectSpec;
  environment: EnvironmentSpec;
  evaluator: EvaluatorSpec;
  execution: JsonObject;
}

const validateRunPlan = new Ajv2020({ allErrors: true, strict: true }).compile(
  runPlanSchema,
);
const catalogMetrics = new Map(metricCatalog.metrics.map((metric) => [metric.id, metric]));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

function jsonSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sameValues(left: unknown[], right: unknown[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertScenarioMode(plan: RunPlan, scenario: JsonObject): void {
  if (plan.mode === "offline") {
    if (scenario.mode !== "conformance" && scenario.mode !== "live") {
      throw new Error("offline mode requires the source scenario's conformance or live mode");
    }
    return;
  }
  if (scenario.mode !== plan.mode) {
    throw new Error(
      `scenario mode ${String(scenario.mode)} does not match run mode ${plan.mode}`,
    );
  }
}

function assertConformance(
  plan: RunPlan,
  scenario: JsonObject,
  execution: ConformanceExecution,
): void {
  if (plan.environment.isolation !== "disposable") {
    throw new Error("conformance mode requires a disposable environment");
  }
  if (plan.environment.approval_reference === undefined) {
    throw new Error("conformance mode requires a disposable-environment approval reference");
  }
  const declaredFaults = (scenario.faults as JsonObject[]) ?? [];
  if (declaredFaults.length === 0) {
    if (execution.fault !== undefined) {
      throw new Error("this scenario declares no injectable fault");
    }
    return;
  }
  if (execution.fault === undefined || execution.trigger === undefined) {
    throw new Error("a faulted conformance scenario requires trigger and fault commands");
  }
  const fault = declaredFaults.find((candidate) => candidate.id === execution.fault?.id);
  if (fault === undefined) {
    throw new Error(`fault ${execution.fault.id} is not declared by the scenario`);
  }
  if (fault.approval_required === true && execution.fault.approval_reference === undefined) {
    throw new Error(`fault ${execution.fault.id} requires an approval reference`);
  }
}

function assertModeBoundary(plan: RunPlan, scenario: JsonObject): void {
  assertScenarioMode(plan, scenario);
  if (plan.mode === "conformance") {
    assertConformance(plan, scenario, plan.execution as ConformanceExecution);
  } else if (plan.mode === "live") {
    if (plan.environment.isolation !== "production-observation") {
      throw new Error("live mode requires production-observation isolation");
    }
  } else if (plan.environment.isolation !== "offline") {
    throw new Error("offline mode requires offline isolation");
  }
}

export function parseRunPlan(value: unknown): RunPlan {
  if (!validateRunPlan(value)) {
    throw new Error(`invalid run plan: ${JSON.stringify(validateRunPlan.errors)}`);
  }
  return structuredClone(value) as unknown as RunPlan;
}

export async function freezeRun(plan: RunPlan, runDirectory: string): Promise<FrozenRun> {
  const scenario = JSON.parse(await readFile(plan.scenario_path, "utf8")) as JsonObject;
  const validation = validateContract("scenario", scenario);
  if (!validation.valid) {
    throw new Error(`invalid scenario: ${JSON.stringify(validation.errors)}`);
  }
  assertModeBoundary(plan, scenario);

  const frozen: FrozenRun = {
    freeze_version: "0.1.0",
    frozen_at: new Date().toISOString(),
    run_id: plan.run_id,
    mode: plan.mode,
    scenario,
    scenario_sha256: jsonSha256(scenario),
    rubric_sha256: jsonSha256(scenario.rubric),
    subject: structuredClone(plan.subject),
    environment: structuredClone(plan.environment),
    evaluator: structuredClone(plan.evaluator),
    execution: structuredClone(plan.execution) as unknown as JsonObject,
  };

  await mkdir(runDirectory, { recursive: false });
  await writeFile(join(runDirectory, "frozen-run.json"), `${JSON.stringify(frozen, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return frozen;
}

async function runCommand(spec: CommandSpec): Promise<string> {
  const process = Bun.spawn(spec.command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${spec.interface} command failed with exit ${exitCode}`);
  }
  return stdout;
}

function assertEvidenceBinding(frozen: FrozenRun, evidence: JsonObject): void {
  const scenario = evidence.scenario as JsonObject;
  const evidenceSubject = evidence.subject as JsonObject;
  const environment = evidence.environment as JsonObject;
  const evaluator = evidence.evaluator as JsonObject;
  const frozenScenario = frozen.scenario;
  const frozenRubric = frozenScenario.rubric as JsonObject;
  if (frozen.mode === "offline") {
    if (evidence.mode !== frozenScenario.mode) {
      throw new Error("offline source evidence mode does not match its frozen scenario");
    }
  } else {
    if (evidence.run_id !== frozen.run_id) throw new Error("evidence run_id changed after freeze");
    if (evidence.mode !== frozen.mode) throw new Error("evidence mode changed after freeze");
  }
  if (scenario.id !== frozenScenario.id || scenario.version !== frozenScenario.version) {
    throw new Error("evidence scenario changed after freeze");
  }
  if (
    evidenceSubject.name !== frozen.subject.name ||
    evidenceSubject.version !== frozen.subject.version ||
    evidenceSubject.source_revision !== frozen.subject.source_revision ||
    !sameValues(evidenceSubject.images as unknown[], frozen.subject.images)
  ) {
    throw new Error("evidence subject changed after freeze");
  }
  if (
    environment.description !== frozen.environment.description ||
    !sameValues(environment.permissions as unknown[], frozen.environment.permissions) ||
    !sameValues(environment.harnesses as unknown[], frozen.environment.harnesses) ||
    !sameValues(environment.models as unknown[], frozen.environment.models) ||
    !sameValues(environment.tools as unknown[], frozen.environment.tools)
  ) {
    throw new Error("evidence environment changed after freeze");
  }
  if (evaluator.rubric_version !== frozenRubric.version) {
    throw new Error("evidence evaluator or rubric changed after freeze");
  }
  if (
    frozen.mode !== "offline" &&
    (evaluator.name !== frozen.evaluator.name ||
      evaluator.version !== frozen.evaluator.version ||
      evaluator.kind !== frozen.evaluator.kind)
  ) {
    throw new Error("evidence evaluator or rubric changed after freeze");
  }
}

function parseEvidence(text: string, frozen: FrozenRun): JsonObject {
  let evidence: JsonObject;
  try {
    evidence = JSON.parse(text) as JsonObject;
  } catch {
    throw new Error("collector returned malformed evidence JSON");
  }
  const validation = validateContract("evidence", evidence);
  if (!validation.valid) {
    throw new Error(`invalid evidence: ${JSON.stringify(validation.errors)}`);
  }
  assertEvidenceBinding(frozen, evidence);
  return evidence;
}

function incompleteEvidence(frozen: FrozenRun, startedAt: string, error: unknown): JsonObject {
  const scenario = frozen.scenario;
  const rubric = scenario.rubric as JsonObject;
  const explanation = error instanceof Error ? error.message : String(error);
  const eventId = "benchmark-runner-failure";
  const metrics = (scenario.metrics as string[]).map((id) => {
    const definition = catalogMetrics.get(id);
    if (definition === undefined) throw new Error(`scenario metric ${id} is not in the catalog`);
    return {
      id,
      state: "unobserved",
      unit: definition.unit,
      reason: `The evaluator did not complete: ${explanation}`,
      source_event_ids: [eventId],
    };
  });
  return {
    schema_version: "0.1.0",
    run_id: frozen.run_id,
    created_at: new Date().toISOString(),
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
    timing: { started_at: startedAt, ended_at: new Date().toISOString() },
    outcome: {
      status: "incomplete",
      summary: `The evaluator did not complete: ${explanation}`,
      acceptance_criteria: (scenario.acceptance_criteria as JsonObject[]).map((criterion) => ({
        id: criterion.id,
        status: "unobserved",
        explanation: "The evaluator failed before this criterion could be verified.",
        evidence_event_ids: [eventId],
      })),
    },
    events: [
      {
        id: eventId,
        at: new Date().toISOString(),
        actor: "evaluator",
        type: "evaluator-failure",
        authority: "benchmark-runner",
        summary: explanation,
      },
    ],
    metrics,
    gates: (rubric.mechanical_gates as JsonObject[]).map((gate) => ({
      id: gate.id,
      status: "unobserved",
      explanation: "The evaluator failed before this gate could be verified.",
      evidence_event_ids: [eventId],
    })),
    artifacts: [],
    redactions: [],
    evaluator: { ...frozen.evaluator, rubric_version: rubric.version },
  };
}

async function collectEvidence(frozen: FrozenRun): Promise<string> {
  if (frozen.mode === "offline") {
    const execution = frozen.execution as unknown as OfflineExecution;
    const source = await readFile(execution.source_bundle_path, "utf8");
    if (sha256(source) !== execution.source_bundle_sha256) {
      throw new Error("offline source bundle digest does not match its frozen digest");
    }
    return source;
  }
  if (frozen.mode === "live") {
    const execution = frozen.execution as unknown as LiveExecution;
    return runCommand(execution.collector);
  }
  const execution = frozen.execution as unknown as ConformanceExecution;
  if (execution.trigger !== undefined) await runCommand(execution.trigger);
  if (execution.fault !== undefined) {
    await runCommand(execution.fault);
  }
  return runCommand(execution.collector);
}

export async function runAttempt(plan: RunPlan, runDirectory: string): Promise<JsonObject> {
  const frozen = await freezeRun(plan, runDirectory);
  const startedAt = new Date().toISOString();
  let evidence: JsonObject;
  try {
    evidence = parseEvidence(await collectEvidence(frozen), frozen);
  } catch (error) {
    evidence = incompleteEvidence(frozen, startedAt, error);
    const validation = validateContract("evidence", evidence);
    if (!validation.valid) {
      throw new Error(`runner produced invalid failure evidence: ${JSON.stringify(validation.errors)}`);
    }
  }
  await writeFile(join(runDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return evidence;
}
