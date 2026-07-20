import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";
import { validateContract } from "../validate";

const benchmarkRoot = join(import.meta.dir, "..");

async function readJson(relativePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(join(benchmarkRoot, relativePath), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

describe("public benchmark contracts", () => {
  test("publishes machine-readable scenarios that satisfy the portable scenario schema", async () => {
    const schema = (await readJson("schemas/scenario.schema.json")) as
      | AnySchema
      | undefined;
    expect(schema).toBeDefined();
    if (schema === undefined) return;

    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const paths = [
      "scenarios/quickstart-to-delivery/scenario.json",
      "scenarios/interrupted-worker-recovery/scenario.json",
    ];

    for (const path of paths) {
      const scenario = await readJson(path);
      expect(scenario).toBeDefined();
      if (scenario === undefined) continue;

      expect(validate(scenario)).toBe(true);
      expect(validate.errors).toBeNull();
      expect(validateContract("scenario", scenario).valid).toBe(true);
    }
  });

  test("publishes a valid evidence example while rejecting an ambiguous metric", async () => {
    const schema = (await readJson("schemas/evidence-bundle.schema.json")) as
      | AnySchema
      | undefined;
    const example = await readJson("tests/fixtures/minimal-evidence-bundle.json");
    expect(schema).toBeDefined();
    expect(example).toBeDefined();
    if (schema === undefined || example === undefined) return;

    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(example)).toBe(true);
    expect(validate.errors).toBeNull();

    const invalid = structuredClone(example) as {
      metrics: Array<{ state?: unknown }>;
    };
    delete invalid.metrics[0]?.state;

    expect(validate(invalid)).toBe(false);

    const unresolved = structuredClone(example) as { metrics: Array<{ source_event_ids: string[] }> };
    unresolved.metrics[0]!.source_event_ids = ["missing-event"];
    expect(validateContract("evidence", unresolved).valid).toBe(false);

    const duplicate = structuredClone(example) as { events: Array<Record<string, unknown>> };
    duplicate.events.push(structuredClone(duplicate.events[0]!));
    expect(validateContract("evidence", duplicate).valid).toBe(false);
  });

  test("validates the catalog and recomputes compact-result gates and aggregates", async () => {
    const catalog = await readJson("metrics/catalog.json");
    const result = await readJson("tests/fixtures/minimal-compact-result.json");
    expect(validateContract("catalog", catalog).valid).toBe(true);
    expect(validateContract("result", result).valid).toBe(true);

    const wrongGate = structuredClone(result) as { attempts: Array<{ mechanical_gates: Array<{ status: string }> }> };
    wrongGate.attempts[0]!.mechanical_gates[0]!.status = "failed";
    expect(validateContract("result", wrongGate).valid).toBe(false);

    const missingValue = structuredClone(result) as { attempts: Array<{ metrics: Array<{ value?: unknown }> }> };
    delete missingValue.attempts[0]!.metrics[0]!.value;
    expect(validateContract("result", missingValue).valid).toBe(false);

    const duplicateAttempt = structuredClone(result) as { attempts: Array<Record<string, unknown>> };
    duplicateAttempt.attempts.push(structuredClone(duplicateAttempt.attempts[0]!));
    expect(validateContract("result", duplicateAttempt).valid).toBe(false);

    const incompleteCatalog = structuredClone(catalog) as { metrics: Array<{ calculation?: string }> };
    delete incompleteCatalog.metrics[0]!.calculation;
    expect(validateContract("catalog", incompleteCatalog).valid).toBe(false);

    const unresolvedAggregate = structuredClone(result) as { aggregates: Array<Record<string, unknown>> };
    unresolvedAggregate.aggregates.push({ metric_id: "efficiency.wall_seconds", observed_count: 0, unobserved_count: 0, not_applicable_count: 0 });
    expect(validateContract("result", unresolvedAggregate).valid).toBe(false);
  });

  test("validates a selected public contract from the command line", async () => {
    const fixture = join(benchmarkRoot, "tests/fixtures/minimal-evidence-bundle.json");
    const valid = Bun.spawn(
      [process.execPath, join(benchmarkRoot, "validate.ts"), "evidence", fixture],
      { stderr: "pipe", stdout: "pipe" },
    );
    expect(await valid.exited).toBe(0);

    const directory = await mkdtemp(join(tmpdir(), "agentos-benchmark-"));
    const invalidPath = join(directory, "invalid.json");
    await writeFile(invalidPath, JSON.stringify({ schema_version: "0.1.0" }));
    const invalid = Bun.spawn(
      [process.execPath, join(benchmarkRoot, "validate.ts"), "evidence", invalidPath],
      { stderr: "pipe", stdout: "pipe" },
    );

    expect(await invalid.exited).toBe(1);
    expect(await new Response(invalid.stderr).text()).toContain("validation failed");
  });
});
