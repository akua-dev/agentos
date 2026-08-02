#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020";
import { Effect, FileSystem, Runtime, Schema, Stdio, Stream } from "effect";

import metricCatalog from "./metrics/catalog.json";
import capacityRecoveryScenario from "./scenarios/captain-authorized-capacity-recovery/scenario.json";
import hierarchyReportingScenario from "./scenarios/hierarchy-reporting-after-background-wake/scenario.json";
import recoveryScenario from "./scenarios/interrupted-worker-recovery/scenario.json";
import quickstartScenario from "./scenarios/quickstart-to-delivery/scenario.json";
import resultSchema from "./schemas/compact-result.schema.json";
import evidenceBundleSchema from "./schemas/evidence-bundle.schema.json";
import metricCatalogSchema from "./schemas/metric-catalog.schema.json";
import scenarioSchema from "./schemas/scenario.schema.json";

export type ContractKind = "catalog" | "evidence" | "result" | "scenario";
type JsonObject = Record<string, unknown>;
type SemanticError = {
  readonly instancePath: string;
  readonly keyword: "semantic";
  readonly message: string;
};

const ContractKindSchema = Schema.Literals([
  "catalog",
  "evidence",
  "result",
  "scenario",
]);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const isJsonObject = Schema.is(JsonObjectSchema);
const JsonFromString = Schema.fromJsonString(Schema.Unknown);

export class BenchmarkValidationError extends Schema.TaggedErrorClass<BenchmarkValidationError>()(
  "BenchmarkValidationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators: Record<ContractKind, ValidateFunction> = {
  catalog: ajv.compile(metricCatalogSchema),
  evidence: ajv.compile(evidenceBundleSchema),
  result: ajv.compile(resultSchema),
  scenario: ajv.compile(scenarioSchema),
};
const scenarios = new Map(
  [
    quickstartScenario,
    recoveryScenario,
    capacityRecoveryScenario,
    hierarchyReportingScenario,
  ].map((scenario) => [scenario.id, scenario]),
);
const catalogMetrics = new Map(
  metricCatalog.metrics.map((metric) => [metric.id, metric]),
);

export type ContractValidation =
  | { readonly valid: true; readonly errors: [] }
  | {
    readonly valid: false;
    readonly errors: Array<ErrorObject | SemanticError>;
  };

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function asValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function duplicateErrors(
  items: ReadonlyArray<JsonObject>,
  path: string,
  key: string,
): SemanticError[] {
  const seen = new Set<unknown>();
  const errors: SemanticError[] = [];
  for (const [index, item] of items.entries()) {
    const value = item[key];
    if (seen.has(value)) {
      errors.push({
        instancePath: `${path}/${index}/${key}`,
        keyword: "semantic",
        message: `duplicate ${key}: ${String(value)}`,
      });
    }
    seen.add(value);
  }
  return errors;
}

function validateMetric(metric: JsonObject, path: string): SemanticError[] {
  const definition = catalogMetrics.get(String(metric.id));
  if (definition === undefined) {
    return [{
      instancePath: `${path}/id`,
      keyword: "semantic",
      message: `unknown metric: ${String(metric.id)}`,
    }];
  }
  const errors: SemanticError[] = [];
  if (metric.unit !== definition.unit) {
    errors.push({
      instancePath: `${path}/unit`,
      keyword: "semantic",
      message: `unit must be ${definition.unit}`,
    });
  }
  if (metric.state === "observed") {
    const actual = typeof metric.value;
    const expected = definition.value_type;
    if (
      expected === "integer"
        ? !(actual === "number" && Number.isInteger(metric.value))
        : actual !== expected
    ) {
      errors.push({
        instancePath: `${path}/value`,
        keyword: "semantic",
        message: `value must be ${expected}`,
      });
    }
  }
  return errors;
}

function semanticEvidence(value: JsonObject): SemanticError[] {
  const events = asObjects(value.events);
  const metrics = asObjects(value.metrics);
  const acceptanceCriteria = asObjects(
    asObject(value.outcome)?.acceptance_criteria,
  );
  const gates = asObjects(value.gates);
  const eventIds = new Set(events.map((event) => event.id));
  const errors = [
    ...duplicateErrors(events, "/events", "id"),
    ...duplicateErrors(metrics, "/metrics", "id"),
    ...duplicateErrors(asObjects(value.artifacts), "/artifacts", "id"),
    ...duplicateErrors(
      acceptanceCriteria,
      "/outcome/acceptance_criteria",
      "id",
    ),
    ...duplicateErrors(gates, "/gates", "id"),
  ];
  for (const [index, metric] of metrics.entries()) {
    errors.push(...validateMetric(metric, `/metrics/${index}`));
    for (const eventId of asValues(metric.source_event_ids)) {
      if (!eventIds.has(eventId)) {
        errors.push({
          instancePath: `/metrics/${index}/source_event_ids`,
          keyword: "semantic",
          message: `unresolved event: ${String(eventId)}`,
        });
      }
    }
  }
  const verdictGroups: ReadonlyArray<readonly [string, JsonObject[]]> = [
    ["/outcome/acceptance_criteria", acceptanceCriteria],
    ["/gates", gates],
  ];
  for (const [path, verdicts] of verdictGroups) {
    for (const [index, verdict] of verdicts.entries()) {
      for (const eventId of asValues(verdict.evidence_event_ids)) {
        if (!eventIds.has(eventId)) {
          errors.push({
            instancePath: `${path}/${index}/evidence_event_ids`,
            keyword: "semantic",
            message: `unresolved event: ${String(eventId)}`,
          });
        }
      }
    }
  }
  return errors;
}

function semanticScenario(value: JsonObject): SemanticError[] {
  const criteria = asObjects(value.acceptance_criteria);
  const rubric = asObject(value.rubric);
  const gates = asObjects(rubric?.mechanical_gates);
  const metrics = asValues(value.metrics);
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const metricIds = new Set(metrics.map(String));
  const errors = [
    ...duplicateErrors(criteria, "/acceptance_criteria", "id"),
    ...duplicateErrors(asObjects(value.roles), "/roles", "id"),
    ...duplicateErrors(asObjects(value.faults), "/faults", "id"),
    ...duplicateErrors(gates, "/rubric/mechanical_gates", "id"),
  ];
  for (const [index, id] of metrics.entries()) {
    if (!catalogMetrics.has(String(id))) {
      errors.push({
        instancePath: `/metrics/${index}`,
        keyword: "semantic",
        message: `unknown metric: ${String(id)}`,
      });
    }
  }
  for (
    const [index, id] of asValues(rubric?.qualitative_criteria).entries()
  ) {
    if (!criterionIds.has(id)) {
      errors.push({
        instancePath: `/rubric/qualitative_criteria/${index}`,
        keyword: "semantic",
        message: `unresolved criterion: ${String(id)}`,
      });
    }
  }
  for (const [index, gate] of gates.entries()) {
    if (!metricIds.has(String(gate.metric_id))) {
      errors.push({
        instancePath: `/rubric/mechanical_gates/${index}/metric_id`,
        keyword: "semantic",
        message: `gate metric is not declared by scenario: ${String(gate.metric_id)}`,
      });
    }
  }
  return errors;
}

function compare(actual: unknown, operator: unknown, expected: unknown): boolean {
  if (operator === "equals") return actual === expected;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  return operator === "less-than-or-equal"
    ? actual <= expected
    : actual >= expected;
}

function expectedGate(gate: JsonObject, metrics: Map<unknown, JsonObject>) {
  const metric = metrics.get(gate.metric_id);
  if (metric?.state !== "observed") return "unobserved";
  return compare(metric.value, gate.operator, gate.expected)
    ? "passed"
    : "failed";
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted.at(middle) ?? 0;
  return ((sorted.at(middle - 1) ?? 0) + (sorted.at(middle) ?? 0)) / 2;
}

function semanticResult(value: JsonObject): SemanticError[] {
  const resultScenario = asObject(value.scenario);
  const scenario = scenarios.get(String(resultScenario?.id));
  if (scenario === undefined) {
    return [{
      instancePath: "/scenario/id",
      keyword: "semantic",
      message: "unresolved scenario",
    }];
  }
  const errors: SemanticError[] = [];
  if (resultScenario?.version !== scenario.version) {
    errors.push({ instancePath: "/scenario/version", keyword: "semantic", message: "scenario version mismatch" });
  }
  if (resultScenario?.rubric_version !== scenario.rubric.version) {
    errors.push({ instancePath: "/scenario/rubric_version", keyword: "semantic", message: "rubric version mismatch" });
  }
  if (value.metric_catalog_version !== metricCatalog.catalog_version) {
    errors.push({ instancePath: "/metric_catalog_version", keyword: "semantic", message: "metric catalog version mismatch" });
  }

  const attempts = asObjects(value.attempts);
  const aggregates = asObjects(value.aggregates);
  errors.push(
    ...duplicateErrors(attempts, "/attempts", "id"),
    ...duplicateErrors(aggregates, "/aggregates", "metric_id"),
  );
  const qualitativeIds = new Set(scenario.rubric.qualitative_criteria);
  const scenarioMetricIds = new Set(scenario.metrics);
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const metrics = asObjects(attempt.metrics);
    const metricMap = new Map(metrics.map((metric) => [metric.id, metric]));
    errors.push(
      ...duplicateErrors(
        metrics,
        `/attempts/${attemptIndex}/metrics`,
        "id",
      ),
    );
    metrics.forEach((metric, index) =>
      errors.push(
        ...validateMetric(metric, `/attempts/${attemptIndex}/metrics/${index}`),
      )
    );
    if (
      attempt.subject_revision !== asObject(value.subject)?.source_revision
    ) {
      errors.push({
        instancePath: `/attempts/${attemptIndex}/subject_revision`,
        keyword: "semantic",
        message: "attempt subject revision must match result subject revision",
      });
    }
    for (const [metricIndex, metric] of metrics.entries()) {
      if (!scenarioMetricIds.has(String(metric.id))) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/metrics/${metricIndex}/id`,
          keyword: "semantic",
          message: "metric is not selected by this scenario",
        });
      }
    }
    for (const metricId of scenarioMetricIds) {
      if (!metricMap.has(metricId)) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/metrics`,
          keyword: "semantic",
          message: `missing scenario metric: ${metricId}`,
        });
      }
    }
    const gates = asObjects(attempt.mechanical_gates);
    errors.push(
      ...duplicateErrors(
        gates,
        `/attempts/${attemptIndex}/mechanical_gates`,
        "id",
      ),
    );
    const rubricGateIds = new Set(
      scenario.rubric.mechanical_gates.map((gate) => gate.id),
    );
    for (const [gateIndex, gate] of gates.entries()) {
      if (!rubricGateIds.has(String(gate.id))) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/mechanical_gates/${gateIndex}/id`,
          keyword: "semantic",
          message: "gate is not declared by this rubric",
        });
      }
    }
    for (const rubricGate of scenario.rubric.mechanical_gates) {
      const verdict = gates.find((gate) => gate.id === rubricGate.id);
      const expected = expectedGate(rubricGate, metricMap);
      if (verdict === undefined) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/mechanical_gates`,
          keyword: "semantic",
          message: `missing gate: ${rubricGate.id}`,
        });
      } else if (verdict.status !== expected) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/mechanical_gates`,
          keyword: "semantic",
          message: `gate ${rubricGate.id} must be ${expected}`,
        });
      }
    }
    const qualitativeVerdicts = asObjects(attempt.qualitative_verdicts);
    errors.push(
      ...duplicateErrors(
        qualitativeVerdicts,
        `/attempts/${attemptIndex}/qualitative_verdicts`,
        "criterion_id",
      ),
    );
    for (const criterionId of qualitativeIds) {
      if (
        !qualitativeVerdicts.some((verdict) =>
          verdict.criterion_id === criterionId
        )
      ) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/qualitative_verdicts`,
          keyword: "semantic",
          message: `missing qualitative verdict: ${criterionId}`,
        });
      }
    }
    for (const [verdictIndex, verdict] of qualitativeVerdicts.entries()) {
      if (!qualitativeIds.has(String(verdict.criterion_id))) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/qualitative_verdicts/${verdictIndex}/criterion_id`,
          keyword: "semantic",
          message: "criterion is not qualitative in this rubric",
        });
      }
      if (verdict.rubric_version !== scenario.rubric.version) {
        errors.push({
          instancePath: `/attempts/${attemptIndex}/qualitative_verdicts/${verdictIndex}/rubric_version`,
          keyword: "semantic",
          message: "rubric version mismatch",
        });
      }
    }
  }

  const attemptedMetricIds = new Set(
    attempts.flatMap((attempt) =>
      asObjects(attempt.metrics).map((metric) => metric.id)
    ),
  );
  for (const metricId of attemptedMetricIds) {
    if (!aggregates.some((aggregate) => aggregate.metric_id === metricId)) {
      errors.push({
        instancePath: "/aggregates",
        keyword: "semantic",
        message: `missing aggregate: ${String(metricId)}`,
      });
    }
  }
  for (const [aggregateIndex, aggregate] of aggregates.entries()) {
    const matching = attempts.flatMap((attempt) => {
      const metric = asObjects(attempt.metrics).find((candidate) =>
        candidate.id === aggregate.metric_id
      );
      return metric === undefined ? [] : [metric];
    });
    if (matching.length !== attempts.length) {
      errors.push({
        instancePath: `/aggregates/${aggregateIndex}`,
        keyword: "semantic",
        message: "aggregate metric missing from an attempt",
      });
    }
    const counts = { observed: 0, unobserved: 0, "not-applicable": 0 };
    for (const metric of matching) {
      if (metric.state === "observed") counts.observed += 1;
      else if (metric.state === "unobserved") counts.unobserved += 1;
      else if (metric.state === "not-applicable") counts["not-applicable"] += 1;
    }
    if (
      aggregate.observed_count !== counts.observed ||
      aggregate.unobserved_count !== counts.unobserved ||
      aggregate.not_applicable_count !== counts["not-applicable"]
    ) {
      errors.push({
        instancePath: `/aggregates/${aggregateIndex}`,
        keyword: "semantic",
        message: "aggregate state counts do not match attempts",
      });
    }
    const values = matching.flatMap((metric) =>
      metric.state === "observed" && typeof metric.value === "number"
        ? [metric.value]
        : []
    );
    const statistics = asObject(aggregate.statistics);
    if (
      values.length > 0 &&
      (statistics?.minimum !== Math.min(...values) ||
        statistics?.median !== median(values) ||
        statistics?.maximum !== Math.max(...values))
    ) {
      errors.push({
        instancePath: `/aggregates/${aggregateIndex}/statistics`,
        keyword: "semantic",
        message: "statistics do not match observed numeric values",
      });
    }
    if (values.length === 0 && statistics !== undefined) {
      errors.push({
        instancePath: `/aggregates/${aggregateIndex}/statistics`,
        keyword: "semantic",
        message: "statistics require observed numeric values",
      });
    }
  }
  return errors;
}

export function validateContract(
  kind: ContractKind,
  value: unknown,
): ContractValidation {
  const validate = validators[kind];
  if (!validate(value)) {
    return { valid: false, errors: validate.errors ?? [] };
  }
  const object = asObject(value);
  if (object === undefined) {
    return {
      valid: false,
      errors: [{
        instancePath: "",
        keyword: "semantic",
        message: "contract root must be an object",
      }],
    };
  }
  const errors = kind === "evidence"
    ? semanticEvidence(object)
    : kind === "scenario"
    ? semanticScenario(object)
    : kind === "result"
    ? semanticResult(object)
    : duplicateErrors(asObjects(object.metrics), "/metrics", "id");
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

export const runContractValidation = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const kind = args[0];
  const path = args[1];
  if (!Schema.is(ContractKindSchema)(kind) || path === undefined) {
    return yield* new BenchmarkValidationError({
      message:
        "usage: bun benchmarks/validate.ts <catalog|scenario|evidence|result> <json-file>",
    });
  }
  const value = yield* fileSystem.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonFromString)),
    Effect.mapError((cause) =>
      new BenchmarkValidationError({
        message: `could not read benchmark contract: ${path}`,
        cause,
      })
    ),
  );
  const result = validateContract(kind, value);
  if (!result.valid) {
    const errors = yield* Schema.encodeEffect(JsonFromString)(
      result.errors,
    ).pipe(
      Effect.mapError((cause) =>
        new BenchmarkValidationError({
          message: `validation failed for ${path}`,
          cause,
        })
      ),
    );
    return yield* new BenchmarkValidationError({
      message: `validation failed for ${path}\n${errors}`,
    });
  }
  yield* Stream.make(`valid ${kind}: ${path}\n`).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError((cause) =>
      new BenchmarkValidationError({
        message: "could not write benchmark validation result",
        cause,
      })
    ),
  );
});

const reportFailure = (error: BenchmarkValidationError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  BunRuntime.runMain(
    runContractValidation.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
