import { readFile } from "node:fs/promises";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import evidenceBundleSchema from "./schemas/evidence-bundle.schema.json";
import scenarioSchema from "./schemas/scenario.schema.json";

type ContractKind = "evidence" | "scenario";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators: Record<ContractKind, ValidateFunction> = {
  evidence: ajv.compile(evidenceBundleSchema),
  scenario: ajv.compile(scenarioSchema),
};

export type ContractValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: ErrorObject[] };

export function validateContract(kind: ContractKind, value: unknown): ContractValidation {
  const validate = validators[kind];
  if (validate(value)) return { valid: true, errors: [] };
  return { valid: false, errors: validate.errors ?? [] };
}

function usage(): never {
  throw new Error("usage: bun benchmarks/validate.ts <scenario|evidence> <json-file>");
}

if (import.meta.main) {
  try {
    const kind = Bun.argv[2];
    const path = Bun.argv[3];
    if ((kind !== "scenario" && kind !== "evidence") || path === undefined) usage();

    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = validateContract(kind, value);
    if (!result.valid) {
      console.error(`validation failed for ${path}`);
      console.error(JSON.stringify(result.errors, null, 2));
      process.exitCode = 1;
    } else {
      console.log(`valid ${kind}: ${path}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
