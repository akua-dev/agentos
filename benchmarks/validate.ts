import { readFile } from "node:fs/promises";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import resultSchema from "./schemas/compact-result.schema.json";
import evidenceBundleSchema from "./schemas/evidence-bundle.schema.json";
import metricCatalogSchema from "./schemas/metric-catalog.schema.json";
import scenarioSchema from "./schemas/scenario.schema.json";
import metricCatalog from "./metrics/catalog.json";
import recoveryScenario from "./scenarios/interrupted-worker-recovery/scenario.json";
import quickstartScenario from "./scenarios/quickstart-to-delivery/scenario.json";

export type ContractKind = "catalog" | "evidence" | "result" | "scenario";
type JsonObject = Record<string, unknown>;
type SemanticError = { instancePath: string; keyword: "semantic"; message: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators: Record<ContractKind, ValidateFunction> = {
  catalog: ajv.compile(metricCatalogSchema),
  evidence: ajv.compile(evidenceBundleSchema),
  result: ajv.compile(resultSchema),
  scenario: ajv.compile(scenarioSchema),
};
const scenarios = new Map(
  [quickstartScenario, recoveryScenario].map((scenario) => [scenario.id, scenario]),
);
const catalogMetrics = new Map(metricCatalog.metrics.map((metric) => [metric.id, metric]));

export type ContractValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: Array<ErrorObject | SemanticError> };

function duplicateErrors(items: JsonObject[], path: string, key: string): SemanticError[] {
  const seen = new Set<unknown>();
  const errors: SemanticError[] = [];
  for (const [index, item] of items.entries()) {
    const value = item[key];
    if (seen.has(value)) errors.push({ instancePath: `${path}/${index}/${key}`, keyword: "semantic", message: `duplicate ${key}: ${String(value)}` });
    seen.add(value);
  }
  return errors;
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value as JsonObject[] : [];
}

function validateMetric(metric: JsonObject, path: string): SemanticError[] {
  const definition = catalogMetrics.get(String(metric.id));
  if (definition === undefined) return [{ instancePath: `${path}/id`, keyword: "semantic", message: `unknown metric: ${String(metric.id)}` }];
  const errors: SemanticError[] = [];
  if (metric.unit !== definition.unit) errors.push({ instancePath: `${path}/unit`, keyword: "semantic", message: `unit must be ${definition.unit}` });
  if (metric.state === "observed") {
    const actual = typeof metric.value;
    const expected = definition.value_type;
    if (expected === "integer" ? !(actual === "number" && Number.isInteger(metric.value)) : actual !== expected) {
      errors.push({ instancePath: `${path}/value`, keyword: "semantic", message: `value must be ${expected}` });
    }
  }
  return errors;
}

function semanticEvidence(value: JsonObject): SemanticError[] {
  const events = asObjects(value.events);
  const metrics = asObjects(value.metrics);
  const acceptanceCriteria = asObjects(
    (value.outcome as JsonObject | undefined)?.acceptance_criteria,
  );
  const gates = asObjects(value.gates);
  const eventIds = new Set(events.map((event) => event.id));
  const errors = [
    ...duplicateErrors(events, "/events", "id"),
    ...duplicateErrors(metrics, "/metrics", "id"),
    ...duplicateErrors(asObjects(value.artifacts), "/artifacts", "id"),
    ...duplicateErrors(acceptanceCriteria, "/outcome/acceptance_criteria", "id"),
    ...duplicateErrors(gates, "/gates", "id"),
  ];
  for (const [index, metric] of metrics.entries()) {
    errors.push(...validateMetric(metric, `/metrics/${index}`));
    for (const eventId of (metric.source_event_ids as unknown[] | undefined) ?? []) {
      if (!eventIds.has(eventId)) errors.push({ instancePath: `/metrics/${index}/source_event_ids`, keyword: "semantic", message: `unresolved event: ${String(eventId)}` });
    }
  }
  for (const [path, verdicts] of [
    ["/outcome/acceptance_criteria", acceptanceCriteria],
    ["/gates", gates],
  ] as const) {
    for (const [index, verdict] of verdicts.entries()) {
      for (const eventId of (verdict.evidence_event_ids as unknown[] | undefined) ?? []) {
        if (!eventIds.has(eventId)) errors.push({ instancePath: `${path}/${index}/evidence_event_ids`, keyword: "semantic", message: `unresolved event: ${String(eventId)}` });
      }
    }
  }
  return errors;
}

function semanticScenario(value: JsonObject): SemanticError[] {
  const criteria = asObjects(value.acceptance_criteria);
  const rubric = value.rubric as JsonObject;
  const gates = asObjects(rubric?.mechanical_gates);
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const metricIds = new Set((value.metrics as unknown[]).map(String));
  const errors = [
    ...duplicateErrors(criteria, "/acceptance_criteria", "id"),
    ...duplicateErrors(asObjects(value.roles), "/roles", "id"),
    ...duplicateErrors(asObjects(value.faults), "/faults", "id"),
    ...duplicateErrors(gates, "/rubric/mechanical_gates", "id"),
  ];
  for (const [index, id] of (value.metrics as unknown[]).entries()) {
    if (!catalogMetrics.has(String(id))) errors.push({ instancePath: `/metrics/${index}`, keyword: "semantic", message: `unknown metric: ${String(id)}` });
  }
  for (const [index, id] of ((rubric?.qualitative_criteria as unknown[]) ?? []).entries()) {
    if (!criterionIds.has(id)) errors.push({ instancePath: `/rubric/qualitative_criteria/${index}`, keyword: "semantic", message: `unresolved criterion: ${String(id)}` });
  }
  for (const [index, gate] of gates.entries()) {
    if (!metricIds.has(String(gate.metric_id))) errors.push({ instancePath: `/rubric/mechanical_gates/${index}/metric_id`, keyword: "semantic", message: `gate metric is not declared by scenario: ${String(gate.metric_id)}` });
  }
  return errors;
}

function compare(actual: unknown, operator: unknown, expected: unknown): boolean {
  if (operator === "equals") return actual === expected;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  return operator === "less-than-or-equal" ? actual <= expected : actual >= expected;
}

function expectedGate(gate: JsonObject, metrics: Map<unknown, JsonObject>): string {
  const metric = metrics.get(gate.metric_id);
  if (metric?.state !== "observed") return "unobserved";
  return compare(metric.value, gate.operator, gate.expected) ? "passed" : "failed";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function semanticResult(value: JsonObject): SemanticError[] {
  const scenario = scenarios.get(String((value.scenario as JsonObject).id));
  if (scenario === undefined) return [{ instancePath: "/scenario/id", keyword: "semantic", message: "unresolved scenario" }];
  const errors: SemanticError[] = [];
  if ((value.scenario as JsonObject).version !== scenario.version) errors.push({ instancePath: "/scenario/version", keyword: "semantic", message: "scenario version mismatch" });
  if ((value.scenario as JsonObject).rubric_version !== scenario.rubric.version) errors.push({ instancePath: "/scenario/rubric_version", keyword: "semantic", message: "rubric version mismatch" });
  if (value.metric_catalog_version !== metricCatalog.catalog_version) errors.push({ instancePath: "/metric_catalog_version", keyword: "semantic", message: "metric catalog version mismatch" });

  const attempts = asObjects(value.attempts);
  errors.push(...duplicateErrors(attempts, "/attempts", "id"), ...duplicateErrors(asObjects(value.aggregates), "/aggregates", "metric_id"));
  const qualitativeIds = new Set(scenario.rubric.qualitative_criteria);
  const scenarioMetricIds = new Set(scenario.metrics);
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const metrics = asObjects(attempt.metrics);
    const metricMap = new Map(metrics.map((metric) => [metric.id, metric]));
    errors.push(...duplicateErrors(metrics, `/attempts/${attemptIndex}/metrics`, "id"));
    metrics.forEach((metric, index) => errors.push(...validateMetric(metric, `/attempts/${attemptIndex}/metrics/${index}`)));
    if (attempt.subject_revision !== (value.subject as JsonObject).source_revision) errors.push({ instancePath: `/attempts/${attemptIndex}/subject_revision`, keyword: "semantic", message: "attempt subject revision must match result subject revision" });
    for (const [metricIndex, metric] of metrics.entries()) {
      if (!scenarioMetricIds.has(String(metric.id))) errors.push({ instancePath: `/attempts/${attemptIndex}/metrics/${metricIndex}/id`, keyword: "semantic", message: "metric is not selected by this scenario" });
    }
    for (const metricId of scenarioMetricIds) {
      if (!metricMap.has(metricId)) errors.push({ instancePath: `/attempts/${attemptIndex}/metrics`, keyword: "semantic", message: `missing scenario metric: ${metricId}` });
    }
    const gates = asObjects(attempt.mechanical_gates);
    errors.push(...duplicateErrors(gates, `/attempts/${attemptIndex}/mechanical_gates`, "id"));
    const rubricGateIds = new Set(scenario.rubric.mechanical_gates.map((gate) => gate.id));
    for (const [gateIndex, gate] of gates.entries()) {
      if (!rubricGateIds.has(String(gate.id))) errors.push({ instancePath: `/attempts/${attemptIndex}/mechanical_gates/${gateIndex}/id`, keyword: "semantic", message: "gate is not declared by this rubric" });
    }
    for (const rubricGate of scenario.rubric.mechanical_gates) {
      const verdict = gates.find((gate) => gate.id === rubricGate.id);
      const expected = expectedGate(rubricGate, metricMap);
      if (verdict === undefined) errors.push({ instancePath: `/attempts/${attemptIndex}/mechanical_gates`, keyword: "semantic", message: `missing gate: ${rubricGate.id}` });
      else if (verdict.status !== expected) errors.push({ instancePath: `/attempts/${attemptIndex}/mechanical_gates`, keyword: "semantic", message: `gate ${rubricGate.id} must be ${expected}` });
    }
    const qualitativeVerdicts = asObjects(attempt.qualitative_verdicts);
    errors.push(...duplicateErrors(qualitativeVerdicts, `/attempts/${attemptIndex}/qualitative_verdicts`, "criterion_id"));
    for (const criterionId of qualitativeIds) {
      if (!qualitativeVerdicts.some((verdict) => verdict.criterion_id === criterionId)) errors.push({ instancePath: `/attempts/${attemptIndex}/qualitative_verdicts`, keyword: "semantic", message: `missing qualitative verdict: ${criterionId}` });
    }
    for (const [verdictIndex, verdict] of qualitativeVerdicts.entries()) {
      if (!qualitativeIds.has(String(verdict.criterion_id))) errors.push({ instancePath: `/attempts/${attemptIndex}/qualitative_verdicts/${verdictIndex}/criterion_id`, keyword: "semantic", message: "criterion is not qualitative in this rubric" });
      if (verdict.rubric_version !== scenario.rubric.version) errors.push({ instancePath: `/attempts/${attemptIndex}/qualitative_verdicts/${verdictIndex}/rubric_version`, keyword: "semantic", message: "rubric version mismatch" });
    }
  }

  const aggregates = asObjects(value.aggregates);
  const attemptedMetricIds = new Set(attempts.flatMap((attempt) => asObjects(attempt.metrics).map((metric) => metric.id)));
  for (const metricId of attemptedMetricIds) {
    if (!aggregates.some((aggregate) => aggregate.metric_id === metricId)) errors.push({ instancePath: "/aggregates", keyword: "semantic", message: `missing aggregate: ${String(metricId)}` });
  }
  for (const [aggregateIndex, aggregate] of aggregates.entries()) {
    const matching = attempts.map((attempt) => asObjects(attempt.metrics).find((metric) => metric.id === aggregate.metric_id)).filter(Boolean) as JsonObject[];
    if (matching.length !== attempts.length) errors.push({ instancePath: `/aggregates/${aggregateIndex}`, keyword: "semantic", message: "aggregate metric missing from an attempt" });
    const counts = { observed: 0, unobserved: 0, "not-applicable": 0 };
    matching.forEach((metric) => counts[metric.state as keyof typeof counts]++);
    if (aggregate.observed_count !== counts.observed || aggregate.unobserved_count !== counts.unobserved || aggregate.not_applicable_count !== counts["not-applicable"]) errors.push({ instancePath: `/aggregates/${aggregateIndex}`, keyword: "semantic", message: "aggregate state counts do not match attempts" });
    const values = matching.filter((metric) => metric.state === "observed" && typeof metric.value === "number").map((metric) => metric.value as number);
    const statistics = aggregate.statistics as JsonObject | undefined;
    if (values.length > 0 && (statistics?.minimum !== Math.min(...values) || statistics?.median !== median(values) || statistics?.maximum !== Math.max(...values))) errors.push({ instancePath: `/aggregates/${aggregateIndex}/statistics`, keyword: "semantic", message: "statistics do not match observed numeric values" });
    if (values.length === 0 && statistics !== undefined) errors.push({ instancePath: `/aggregates/${aggregateIndex}/statistics`, keyword: "semantic", message: "statistics require observed numeric values" });
  }
  return errors;
}

export function validateContract(kind: ContractKind, value: unknown): ContractValidation {
  const validate = validators[kind];
  if (!validate(value)) return { valid: false, errors: validate.errors ?? [] };
  const object = value as JsonObject;
  const errors = kind === "evidence" ? semanticEvidence(object) : kind === "scenario" ? semanticScenario(object) : kind === "result" ? semanticResult(object) : duplicateErrors(asObjects(object.metrics), "/metrics", "id");
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function usage(): never {
  throw new Error("usage: bun benchmarks/validate.ts <catalog|scenario|evidence|result> <json-file>");
}

if (import.meta.main) {
  try {
    const kind = Bun.argv[2] as ContractKind;
    const path = Bun.argv[3];
    if (!(["catalog", "scenario", "evidence", "result"] as string[]).includes(kind) || path === undefined) usage();
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = validateContract(kind, value);
    if (!result.valid) {
      console.error(`validation failed for ${path}`);
      console.error(JSON.stringify(result.errors, null, 2));
      process.exitCode = 1;
    } else console.log(`valid ${kind}: ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
