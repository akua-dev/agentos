import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";

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
