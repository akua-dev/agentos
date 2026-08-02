import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { validateContract } from "../validate.ts";

type JsonObject = Record<string, unknown>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema);
const JsonFromString = Schema.fromJsonString(Schema.Unknown);
const isJsonObject = Schema.is(JsonObjectSchema);

function asObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function withoutKey(object: JsonObject, key: string): JsonObject {
  return Object.fromEntries(
    Object.entries(object).filter(([candidate]) => candidate !== key),
  );
}

function replaceFirst(
  values: ReadonlyArray<JsonObject>,
  update: (value: JsonObject) => JsonObject,
) {
  const first = values.at(0);
  return first === undefined ? [] : [update(first), ...values.slice(1)];
}

function updateFirstAttempt(
  result: JsonObject,
  update: (attempt: JsonObject) => JsonObject,
): JsonObject {
  return {
    ...result,
    attempts: replaceFirst(asObjects(result.attempts), update),
  };
}

const readJson = Effect.fn("test.benchmarkContracts.readJson")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonObjectFromString)),
    );
  },
);

const run = Effect.fn("test.benchmarkContracts.run")(function*(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, args, {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

describe("public benchmark contracts", () => {
  it.effect("publishes valid machine-readable scenarios", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const schema = yield* readJson(paths.join(root, "schemas", "scenario.schema.json"));
      assert.strictEqual(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      const scenarioPaths = [
        "quickstart-to-delivery",
        "interrupted-worker-recovery",
        "hierarchy-reporting-after-background-wake",
        "captain-authorized-capacity-recovery",
      ];
      for (const name of scenarioPaths) {
        const scenario = yield* readJson(
          paths.join(root, "scenarios", name, "scenario.json"),
        );
        assert.isTrue(validateContract("scenario", scenario).valid, name);
        if (name === "hierarchy-reporting-after-background-wake") {
          assert.strictEqual(asObject(scenario.rubric).version, "0.2.0");
          assert.strictEqual(scenario.version, "0.2.0");
        }
      }
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("accepts valid evidence and rejects ambiguous evidence", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const schema = yield* readJson(paths.join(root, "schemas", "evidence-bundle.schema.json"));
      const example = yield* readJson(paths.join(root, "tests", "fixtures", "minimal-evidence-bundle.json"));
      assert.strictEqual(schema.type, "object");
      assert.isTrue(validateContract("evidence", example).valid);

      const metrics = asObjects(example.metrics);
      const invalid = {
        ...example,
        metrics: replaceFirst(metrics, (metric) => withoutKey(metric, "state")),
      };
      assert.isFalse(validateContract("evidence", invalid).valid);

      const unresolved = {
        ...example,
        metrics: replaceFirst(metrics, (metric) => ({
          ...metric,
          source_event_ids: ["missing-event"],
        })),
      };
      assert.isFalse(validateContract("evidence", unresolved).valid);

      const events = asObjects(example.events);
      const duplicate = {
        ...example,
        events: [...events, structuredClone(events.at(0) ?? {})],
      };
      assert.isFalse(validateContract("evidence", duplicate).valid);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("scopes verdict identifiers to their own collections", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const example = yield* readJson(paths.join(root, "tests", "fixtures", "minimal-evidence-bundle.json"));
      const outcome = asObject(example.outcome);
      const criteria = asObjects(outcome.acceptance_criteria);
      const gates = asObjects(example.gates);
      const criterionId = criteria.at(0)?.id;

      const sharedAcrossCollections = {
        ...example,
        gates: replaceFirst(gates, (gate) => ({ ...gate, id: criterionId })),
      };
      assert.isTrue(validateContract("evidence", sharedAcrossCollections).valid);

      const duplicateCriterion = {
        ...example,
        outcome: {
          ...outcome,
          acceptance_criteria: [
            ...criteria,
            structuredClone(criteria.at(0) ?? {}),
          ],
        },
      };
      assert.isFalse(validateContract("evidence", duplicateCriterion).valid);

      const duplicateGate = {
        ...example,
        gates: [...gates, structuredClone(gates.at(0) ?? {})],
      };
      assert.isFalse(validateContract("evidence", duplicateGate).valid);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("validates catalog, gates, and compact-result aggregates", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const catalog = yield* readJson(paths.join(root, "metrics", "catalog.json"));
      const result = yield* readJson(paths.join(root, "tests", "fixtures", "minimal-compact-result.json"));
      assert.isTrue(validateContract("catalog", catalog).valid);
      assert.isTrue(validateContract("result", result).valid);

      const deterministicEvaluator = updateFirstAttempt(result, (attempt) => {
        const verdicts = asObjects(attempt.qualitative_verdicts);
        return {
          ...attempt,
          qualitative_verdicts: replaceFirst(verdicts, (verdict) => ({
            ...verdict,
            evaluator: {
              ...asObject(verdict.evaluator),
              kind: "deterministic",
            },
          })),
        };
      });
      assert.isTrue(validateContract("result", deterministicEvaluator).valid);

      const wrongGate = updateFirstAttempt(result, (attempt) => ({
        ...attempt,
        mechanical_gates: replaceFirst(
          asObjects(attempt.mechanical_gates),
          (gate) => ({ ...gate, status: "failed" }),
        ),
      }));
      assert.isFalse(validateContract("result", wrongGate).valid);

      const missingValue = updateFirstAttempt(result, (attempt) => ({
        ...attempt,
        metrics: asObjects(attempt.metrics).map((metric) =>
          metric.id === "effectiveness.outcome_success"
            ? withoutKey(metric, "value")
            : metric
        ),
      }));
      assert.isFalse(validateContract("result", missingValue).valid);

      const attempts = asObjects(result.attempts);
      const duplicateAttempt = {
        ...result,
        attempts: [...attempts, structuredClone(attempts.at(0) ?? {})],
      };
      assert.isFalse(validateContract("result", duplicateAttempt).valid);

      const omittedMetric = updateFirstAttempt(result, (attempt) => ({
        ...attempt,
        metrics: asObjects(attempt.metrics).slice(0, -1),
      }));
      assert.isFalse(validateContract("result", omittedMetric).valid);

      const undeclaredMetric = updateFirstAttempt(result, (attempt) => ({
        ...attempt,
        metrics: [...asObjects(attempt.metrics), {
          id: "efficiency.model_tokens",
          state: "unobserved",
          unit: "tokens",
          reason: "Synthetic telemetry is absent.",
        }],
      }));
      assert.isFalse(validateContract("result", undeclaredMetric).valid);

      const revisionMismatch = updateFirstAttempt(result, (attempt) => ({
        ...attempt,
        subject_revision: "1111111111111111111111111111111111111111",
      }));
      assert.isFalse(validateContract("result", revisionMismatch).valid);

      const catalogMetrics = asObjects(catalog.metrics);
      const incompleteCatalog = {
        ...catalog,
        metrics: replaceFirst(
          catalogMetrics,
          (metric) => withoutKey(metric, "calculation"),
        ),
      };
      assert.isFalse(validateContract("catalog", incompleteCatalog).valid);

      const unresolvedAggregate = {
        ...result,
        aggregates: [...asObjects(result.aggregates), {
          metric_id: "efficiency.wall_seconds",
          observed_count: 0,
          unobserved_count: 0,
          not_applicable_count: 0,
        }],
      };
      assert.isFalse(validateContract("result", unresolvedAggregate).valid);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("validates a selected contract from the command line", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const fixture = paths.join(root, "tests", "fixtures", "minimal-evidence-bundle.json");
      const valid = yield* run("bun", ["validate.ts", "evidence", fixture], root);
      assert.strictEqual(valid.exitCode, 0, valid.stderr);

      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-benchmark-",
      });
      const invalidPath = paths.join(directory, "invalid.json");
      yield* fileSystem.writeFileString(
        invalidPath,
        yield* Schema.encodeEffect(JsonFromString)({ schema_version: "0.1.0" }),
      );
      const invalid = yield* run("bun", ["validate.ts", "evidence", invalidPath], root);
      assert.strictEqual(invalid.exitCode, 1);
      assert.include(invalid.stderr, "validation failed");
    })).pipe(Effect.provide(BunServices.layer)));
});
