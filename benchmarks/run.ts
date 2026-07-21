import { readFile } from "node:fs/promises";

import { parseRunPlan, runAttempt } from "./runner";

function usage(): never {
  throw new Error("usage: bun benchmarks/run.ts <run-plan.json> <new-run-directory>");
}

if (import.meta.main) {
  try {
    const planPath = Bun.argv[2];
    const runDirectory = Bun.argv[3];
    if (planPath === undefined || runDirectory === undefined) usage();
    const plan = parseRunPlan(JSON.parse(await readFile(planPath, "utf8")));
    const evidence = await runAttempt(plan, runDirectory);
    console.log(`valid evidence: ${runDirectory}/evidence.json (${String(evidence.run_id)})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
