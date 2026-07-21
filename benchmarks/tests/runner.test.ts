import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunPlan } from "../runner";
import { parseRunPlan, runAttempt } from "../runner";
import { validateContract } from "../validate";

const benchmarkRoot = join(import.meta.dir, "..");
const quickstartScenarioPath = join(
  benchmarkRoot,
  "scenarios",
  "quickstart-to-delivery",
  "scenario.json",
);
const recoveryScenarioPath = join(
  benchmarkRoot,
  "scenarios",
  "interrupted-worker-recovery",
  "scenario.json",
);
const frozenConformanceEvidencePath = join(
  benchmarkRoot,
  "tests",
  "fixtures",
  "minimal-evidence-bundle.json",
);

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

async function fixture(name: string): Promise<Record<string, any>> {
  return readJson(join(benchmarkRoot, "tests", "fixtures", name));
}

async function writeScenario(
  directory: string,
  mode: RunPlan["mode"],
  source = "quickstart-to-delivery",
): Promise<string> {
  const scenario = await readJson(join(benchmarkRoot, "scenarios", source, "scenario.json"));
  scenario.mode = mode;
  scenario.environment.isolation =
    mode === "conformance" ? "disposable" : mode === "live" ? "production-observation" : "offline";
  const path = join(directory, `${mode}-scenario.json`);
  await writeFile(path, JSON.stringify(scenario));
  return path;
}

function environment(mode: RunPlan["mode"]): RunPlan["environment"] {
  return {
    description: `Synthetic ${mode} runner test.`,
    isolation:
      mode === "conformance" ? "disposable" : mode === "live" ? "production-observation" : "offline",
    permissions: ["Observe the synthetic fixture"],
    ...(mode === "conformance" ? { approval_reference: "approval:synthetic-disposable" } : {}),
    harnesses: [{ name: "fixture-harness", version: "0.0.0" }],
    models: [{ name: "fixture-model", version: "0.0.0" }],
    tools: [{ name: "fixture-tool", version: "0.0.0" }],
  };
}

async function evidenceFor(
  plan: Omit<RunPlan, "execution">,
  mode: RunPlan["mode"],
): Promise<Record<string, any>> {
  const evidence = await fixture("minimal-evidence-bundle.json");
  const scenario = await readJson(plan.scenario_path);
  evidence.run_id = plan.run_id;
  evidence.mode = mode;
  evidence.scenario = { id: scenario.id, version: scenario.version };
  evidence.subject = structuredClone(plan.subject);
  evidence.environment = {
    description: plan.environment.description,
    permissions: plan.environment.permissions,
    harnesses: plan.environment.harnesses,
    models: plan.environment.models,
    tools: plan.environment.tools,
  };
  evidence.evaluator = { ...plan.evaluator, rubric_version: scenario.rubric.version };
  return evidence;
}

function basePlan(mode: RunPlan["mode"], scenarioPath: string): Omit<RunPlan, "execution"> {
  return {
    schema_version: "0.1.0",
    run_id: `${mode}-runner-attempt`,
    mode,
    scenario_path: scenarioPath,
    subject: {
      name: "synthetic-subject",
      version: "0.0.0",
      source_revision: "0000000000000000000000000000000000000000",
      images: [],
    },
    environment: environment(mode),
    evaluator: { kind: "deterministic", name: "runner-test", version: "0.1.0" },
  };
}

function planForFrozenEvidence(
  mode: "conformance" | "offline",
  evidence: Record<string, any>,
): Omit<RunPlan, "execution"> {
  return {
    schema_version: "0.1.0",
    run_id: mode === "offline" ? "offline-verification-attempt" : evidence.run_id,
    mode,
    scenario_path: quickstartScenarioPath,
    subject: structuredClone(evidence.subject),
    environment: {
      description: evidence.environment.description,
      isolation: mode === "offline" ? "offline" : "disposable",
      ...(mode === "conformance"
        ? { approval_reference: "approval:synthetic-disposable" }
        : {}),
      permissions: structuredClone(evidence.environment.permissions),
      harnesses: structuredClone(evidence.environment.harnesses),
      models: structuredClone(evidence.environment.models),
      tools: structuredClone(evidence.environment.tools),
    },
    evaluator:
      mode === "offline"
        ? { kind: "deterministic", name: "offline-verifier", version: "0.1.0" }
        : {
            kind: evidence.evaluator.kind,
            name: evidence.evaluator.name,
            version: evidence.evaluator.version,
          },
  };
}

async function collectorCommand(
  directory: string,
  evidence: Record<string, any>,
  requiredFreeze?: string,
): Promise<string[]> {
  const evidencePath = join(directory, "collector-evidence.json");
  const collectorPath = join(directory, "collector.ts");
  await writeFile(evidencePath, JSON.stringify(evidence));
  await writeFile(
    collectorPath,
    [
      'import { readFile } from "node:fs/promises";',
      requiredFreeze === undefined
        ? ""
        : `await readFile(${JSON.stringify(requiredFreeze)}, "utf8");`,
      `process.stdout.write(await readFile(${JSON.stringify(evidencePath)}, "utf8"));`,
    ].join("\n"),
  );
  return [process.execPath, collectorPath];
}

describe("portable benchmark runner", () => {
  test("runs the unmodified fault-free quickstart scenario from start to collect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const frozenEvidence = await fixture("minimal-evidence-bundle.json");
    const base = planForFrozenEvidence("conformance", frozenEvidence);
    const runDirectory = join(directory, "attempt");
    const logPath = join(directory, "interfaces.log");
    const interfacePath = join(directory, "interface.ts");
    await writeFile(
      interfacePath,
      [
        'import { appendFile, readFile } from "node:fs/promises";',
        "const [logPath, label, evidencePath, freezePath] = process.argv.slice(2);",
        'if (freezePath) await readFile(freezePath, "utf8");',
        'await appendFile(logPath!, `${label}\\n`);',
        'if (evidencePath) process.stdout.write(await readFile(evidencePath, "utf8"));',
      ].join("\n"),
    );
    const plan: RunPlan = {
      ...base,
      execution: {
        trigger: {
          interface: "synthetic native start interface",
          command: [process.execPath, interfacePath, logPath, "start"],
        },
        collector: {
          interface: "synthetic public fixture",
          command: [
            process.execPath,
            interfacePath,
            logPath,
            "collect",
            frozenConformanceEvidencePath,
            join(runDirectory, "frozen-run.json"),
          ],
        },
      },
    };

    const evidence = await runAttempt(parseRunPlan(plan), runDirectory);
    const frozen = await readJson(join(runDirectory, "frozen-run.json"));
    expect(frozen.scenario_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(frozen.rubric_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(frozen.subject.source_revision).toBe(plan.subject.source_revision);
    expect(await readFile(logPath, "utf8")).toBe("start\ncollect\n");
    expect(frozen.scenario).toEqual(await readJson(quickstartScenarioPath));
    expect(validateContract("evidence", evidence).valid).toBe(true);
  });

  test("rejects an undeclared conformance fault before any command runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const base = basePlan("conformance", recoveryScenarioPath);
    const marker = join(directory, "command-ran");
    const command = [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`];
    const plan: RunPlan = {
      ...base,
      execution: {
        collector: { interface: "synthetic collector", command },
        trigger: { interface: "synthetic trigger", command },
        fault: {
          id: "undeclared-fault",
          interface: "synthetic fault interface",
          command,
          approval_reference: "approval:synthetic",
        },
      },
    };

    expect(runAttempt(parseRunPlan(plan), join(directory, "attempt"))).rejects.toThrow(
      "is not declared by the scenario",
    );
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("injects the one approved declared fault after its trigger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const base = basePlan("conformance", recoveryScenarioPath);
    const evidencePath = join(directory, "collector-evidence.json");
    const logPath = join(directory, "interfaces.log");
    const interfacePath = join(directory, "interface.ts");
    await writeFile(evidencePath, JSON.stringify(await evidenceFor(base, "conformance")));
    await writeFile(
      interfacePath,
      [
        'import { appendFile, readFile } from "node:fs/promises";',
        "const [logPath, label, evidencePath] = process.argv.slice(2);",
        'await appendFile(logPath!, `${label}\\n`);',
        'if (evidencePath) process.stdout.write(await readFile(evidencePath, "utf8"));',
      ].join("\n"),
    );
    const command = (label: string, includeEvidence = false) => [
      process.execPath,
      interfacePath,
      logPath,
      label,
      ...(includeEvidence ? [evidencePath] : []),
    ];
    const plan: RunPlan = {
      ...base,
      execution: {
        trigger: { interface: "synthetic native trigger", command: command("trigger") },
        fault: {
          id: "terminate-worker-runtime",
          interface: "synthetic native runtime interface",
          command: command("fault"),
          approval_reference: "approval:synthetic-fault",
        },
        collector: {
          interface: "synthetic native evidence interfaces",
          command: command("collect", true),
        },
      },
    };

    await runAttempt(parseRunPlan(plan), join(directory, "attempt"));
    expect(await readFile(logPath, "utf8")).toBe("trigger\nfault\ncollect\n");
  });

  test("live plans expose only completed-work collection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const scenarioPath = await writeScenario(directory, "live");
    const base = basePlan("live", scenarioPath);
    const evidence = await evidenceFor(base, "live");
    const plan: RunPlan = {
      ...base,
      execution: {
        completed_work_reference: "review:synthetic/1",
        collector: {
          interface: "synthetic provider read interface",
          command: await collectorCommand(directory, evidence),
        },
      },
    };
    expect((await runAttempt(parseRunPlan(plan), join(directory, "attempt"))).mode).toBe("live");

    const withFault = structuredClone(plan) as Record<string, any>;
    withFault.execution.fault = { id: "fault", interface: "bad", command: ["bad"] };
    expect(() => parseRunPlan(withFault)).toThrow("invalid run plan");
  });

  test("offline mode preserves an immutable conformance run's execution identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const source = await readFile(frozenConformanceEvidencePath, "utf8");
    const frozenEvidence = JSON.parse(source) as Record<string, any>;
    const base = planForFrozenEvidence("offline", frozenEvidence);
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`;
    const plan: RunPlan = {
      ...base,
      execution: {
        source_bundle_path: frozenConformanceEvidencePath,
        source_bundle_sha256: digest,
      },
    };

    const evidence = await runAttempt(parseRunPlan(plan), join(directory, "attempt"));
    expect(evidence.run_id).toBe(frozenEvidence.run_id);
    expect(evidence.run_id).not.toBe(plan.run_id);
    expect(evidence.mode).toBe("conformance");
    expect(evidence.evaluator).toEqual(frozenEvidence.evaluator);
    expect(await readFile(frozenConformanceEvidencePath, "utf8")).toBe(source);
    expect(validateContract("evidence", evidence).valid).toBe(true);

    const withCommand = structuredClone(plan) as Record<string, any>;
    withCommand.execution.command = ["subject-contact"];
    expect(() => parseRunPlan(withCommand)).toThrow("invalid run plan");
  });

  test("offline mode emits deliberately noncanonical source bytes unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const frozenEvidence = await fixture("minimal-evidence-bundle.json");
    const source = ` \n${JSON.stringify(frozenEvidence)}\t\n\n`;
    const sourcePath = join(directory, "noncanonical-frozen-evidence.json");
    await writeFile(sourcePath, source);
    const plan: RunPlan = {
      ...planForFrozenEvidence("offline", frozenEvidence),
      execution: {
        source_bundle_path: sourcePath,
        source_bundle_sha256: `sha256:${new Bun.CryptoHasher("sha256")
          .update(source)
          .digest("hex")}`,
      },
    };
    const runDirectory = join(directory, "attempt");

    await runAttempt(parseRunPlan(plan), runDirectory);

    expect(await readFile(join(runDirectory, "evidence.json"), "utf8")).toBe(source);
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  });

  test("emits schema-valid incomplete evidence when collection fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-runner-"));
    const base = basePlan("conformance", quickstartScenarioPath);
    const plan: RunPlan = {
      ...base,
      execution: {
        collector: {
          interface: "synthetic failing collector",
          command: [process.execPath, "-e", "process.exit(7)"],
        },
      },
    };
    const runDirectory = join(directory, "attempt");
    const evidence = await runAttempt(parseRunPlan(plan), runDirectory);
    expect((evidence.outcome as Record<string, unknown>).status).toBe("incomplete");
    expect(validateContract("evidence", evidence).valid).toBe(true);
    expect(await Bun.file(join(runDirectory, "evidence.json")).exists()).toBe(true);
  });
});
