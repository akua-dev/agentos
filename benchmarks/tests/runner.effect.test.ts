import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Path, Schema } from "effect";

import type { RunPlan } from "../runner.ts";
import { parseRunPlan, runAttempt } from "../runner.ts";
import { validateContract } from "../validate.ts";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema);
const JsonFromString = Schema.fromJsonString(Schema.Unknown);
const isJsonObject = Schema.is(JsonObjectSchema);
const EvidenceIdentitySchema = Schema.Struct({
  run_id: Schema.String,
  subject: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    source_revision: Schema.String,
    images: Schema.Array(Schema.String),
  }),
  environment: Schema.Struct({
    description: Schema.String,
    permissions: Schema.Array(Schema.String),
    harnesses: Schema.Array(Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    })),
    models: Schema.Array(Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    })),
    tools: Schema.Array(Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    })),
  }),
  evaluator: Schema.Struct({
    kind: Schema.Literals(["deterministic", "model", "human", "hybrid"]),
    name: Schema.String,
    version: Schema.String,
  }),
});

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

const readJson = Effect.fn("test.benchmarkRunner.readJson")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JsonObjectFromString)),
    );
  },
);

const writeJson = Effect.fn("test.benchmarkRunner.writeJson")(
  function*(path: string, value: unknown) {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(JsonFromString)(value);
    yield* fileSystem.writeFileString(path, `${encoded}\n`);
  },
);

const sha256 = Effect.fn("test.benchmarkRunner.sha256")(
  function*(value: string) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return `sha256:${Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  },
);

function environment(mode: RunPlan["mode"]): RunPlan["environment"] {
  return {
    description: `Synthetic ${mode} runner test.`,
    isolation: mode === "conformance"
      ? "disposable"
      : mode === "live"
      ? "production-observation"
      : "offline",
    permissions: ["Observe the synthetic fixture"],
    ...(mode === "conformance"
      ? { approval_reference: "approval:synthetic-disposable" }
      : {}),
    harnesses: [{ name: "fixture-harness", version: "0.0.0" }],
    models: [{ name: "fixture-model", version: "0.0.0" }],
    tools: [{ name: "fixture-tool", version: "0.0.0" }],
  };
}

function basePlan(
  mode: RunPlan["mode"],
  scenarioPath: string,
): Omit<RunPlan, "execution"> {
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
    evaluator: {
      kind: "deterministic",
      name: "runner-test",
      version: "0.1.0",
    },
  };
}

function planForFrozenEvidence(
  mode: "conformance" | "offline",
  evidence: typeof EvidenceIdentitySchema.Type,
  quickstartScenarioPath: string,
): Omit<RunPlan, "execution"> {
  return {
    schema_version: "0.1.0",
    run_id: mode === "offline"
      ? "offline-verification-attempt"
      : evidence.run_id,
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
    evaluator: mode === "offline"
      ? {
        kind: "deterministic",
        name: "offline-verifier",
        version: "0.1.0",
      }
      : structuredClone(evidence.evaluator),
  };
}

const writeScenario = Effect.fn("test.benchmarkRunner.writeScenario")(
  function*(
    directory: string,
    mode: RunPlan["mode"],
    sourcePath: string,
  ) {
    const paths = yield* Path.Path;
    const scenario = yield* readJson(sourcePath);
    const sourceEnvironment = asObject(scenario.environment) ?? {};
    const updated = {
      ...scenario,
      mode,
      environment: {
        ...sourceEnvironment,
        isolation: mode === "conformance"
          ? "disposable"
          : mode === "live"
          ? "production-observation"
          : "offline",
      },
    };
    const path = paths.join(directory, `${mode}-scenario.json`);
    yield* writeJson(path, updated);
    return path;
  },
);

const evidenceFor = Effect.fn("test.benchmarkRunner.evidenceFor")(
  function*(
    plan: Omit<RunPlan, "execution">,
    mode: RunPlan["mode"],
    fixturePath: string,
  ) {
    const evidence = yield* readJson(fixturePath);
    const scenario = yield* readJson(plan.scenario_path);
    const rubric = asObject(scenario.rubric);
    return {
      ...evidence,
      run_id: plan.run_id,
      mode,
      scenario: { id: scenario.id, version: scenario.version },
      subject: structuredClone(plan.subject),
      environment: {
        description: plan.environment.description,
        permissions: plan.environment.permissions,
        harnesses: plan.environment.harnesses,
        models: plan.environment.models,
        tools: plan.environment.tools,
      },
      evaluator: {
        ...plan.evaluator,
        rubric_version: rubric?.version,
      },
    };
  },
);

function interfaceCommand(options: {
  readonly logPath: string;
  readonly label: string;
  readonly evidencePath?: string;
  readonly freezePath?: string;
}) {
  return [
    "sh",
    "-c",
    'test -z "$4" || test -f "$4"; printf "%s\\n" "$2" >> "$1"; test -z "$3" || cat "$3"',
    "agentos-interface",
    options.logPath,
    options.label,
    ...(options.evidencePath === undefined ? [] : [options.evidencePath]),
    ...(options.freezePath === undefined ? [] : [options.freezePath]),
  ];
}

function collectorCommand(
  evidencePath: string,
  requiredFreeze?: string,
) {
  return [
    "sh",
    "-c",
    'test -z "$2" || test -f "$2"; cat "$1"',
    "agentos-collector",
    evidencePath,
    ...(requiredFreeze === undefined ? [] : [requiredFreeze]),
  ];
}

describe("portable benchmark runner", () => {
  it.effect("runs the quickstart scenario from start to collect", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(
        new URL("..", import.meta.url),
      );
      const quickstartScenarioPath = paths.join(
        benchmarkRoot,
        "scenarios",
        "quickstart-to-delivery",
        "scenario.json",
      );
      const frozenEvidencePath = paths.join(
        benchmarkRoot,
        "tests",
        "fixtures",
        "minimal-evidence-bundle.json",
      );
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-runner-",
      });
      const frozenEvidence = yield* readJson(frozenEvidencePath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EvidenceIdentitySchema)),
      );
      const base = planForFrozenEvidence(
        "conformance",
        frozenEvidence,
        quickstartScenarioPath,
      );
      const runDirectory = paths.join(directory, "attempt");
      const logPath = paths.join(directory, "interfaces.log");
      const plan: RunPlan = {
        ...base,
        execution: {
          trigger: {
            interface: "synthetic native start interface",
            command: interfaceCommand({ logPath, label: "start" }),
          },
          collector: {
            interface: "synthetic public fixture",
            command: interfaceCommand({
              logPath,
              label: "collect",
              evidencePath: frozenEvidencePath,
              freezePath: paths.join(runDirectory, "frozen-run.json"),
            }),
          },
        },
      };

      const evidence = yield* runAttempt(yield* parseRunPlan(plan), runDirectory);
      const frozen = yield* readJson(
        paths.join(runDirectory, "frozen-run.json"),
      );
      assert.match(String(frozen.scenario_sha256), /^sha256:[a-f0-9]{64}$/);
      assert.match(String(frozen.rubric_sha256), /^sha256:[a-f0-9]{64}$/);
      assert.strictEqual(
        asObject(frozen.subject)?.source_revision,
        plan.subject.source_revision,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(logPath),
        "start\ncollect\n",
      );
      assert.deepStrictEqual(
        frozen.scenario,
        yield* readJson(quickstartScenarioPath),
      );
      assert.isTrue(validateContract("evidence", evidence).valid);
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("rejects an undeclared fault before any command runs", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const recoveryScenarioPath = paths.join(
        benchmarkRoot,
        "scenarios",
        "interrupted-worker-recovery",
        "scenario.json",
      );
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const marker = paths.join(directory, "command-ran");
      const command = ["sh", "-c", 'printf ran > "$1"', "agentos-marker", marker];
      const plan: RunPlan = {
        ...basePlan("conformance", recoveryScenarioPath),
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
      const failure = yield* runAttempt(
        yield* parseRunPlan(plan),
        paths.join(directory, "attempt"),
      ).pipe(Effect.flip);
      assert.include(failure.message, "is not declared by the scenario");
      assert.isFalse(yield* fileSystem.exists(marker));
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("injects the approved declared fault after its trigger", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const recoveryScenarioPath = paths.join(benchmarkRoot, "scenarios", "interrupted-worker-recovery", "scenario.json");
      const fixturePath = paths.join(benchmarkRoot, "tests", "fixtures", "minimal-evidence-bundle.json");
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const base = basePlan("conformance", recoveryScenarioPath);
      const evidencePath = paths.join(directory, "collector-evidence.json");
      const logPath = paths.join(directory, "interfaces.log");
      yield* writeJson(
        evidencePath,
        yield* evidenceFor(base, "conformance", fixturePath),
      );
      const command = (label: string, includeEvidence = false) =>
        interfaceCommand({
          logPath,
          label,
          evidencePath: includeEvidence ? evidencePath : undefined,
        });
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
      yield* runAttempt(yield* parseRunPlan(plan), paths.join(directory, "attempt"));
      assert.strictEqual(yield* fileSystem.readFileString(logPath), "trigger\nfault\ncollect\n");
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("live plans expose only completed-work collection", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const quickstart = paths.join(benchmarkRoot, "scenarios", "quickstart-to-delivery", "scenario.json");
      const fixturePath = paths.join(benchmarkRoot, "tests", "fixtures", "minimal-evidence-bundle.json");
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const scenarioPath = yield* writeScenario(directory, "live", quickstart);
      const base = basePlan("live", scenarioPath);
      const evidencePath = paths.join(directory, "collector-evidence.json");
      yield* writeJson(evidencePath, yield* evidenceFor(base, "live", fixturePath));
      const plan: RunPlan = {
        ...base,
        execution: {
          completed_work_reference: "review:synthetic/1",
          collector: {
            interface: "synthetic provider read interface",
            command: collectorCommand(evidencePath),
          },
        },
      };
      const evidence = yield* runAttempt(yield* parseRunPlan(plan), paths.join(directory, "attempt"));
      assert.strictEqual(evidence.mode, "live");

      const invalid = {
        ...plan,
        execution: { ...plan.execution, fault: { id: "fault", interface: "bad", command: ["bad"] } },
      };
      const failure = yield* parseRunPlan(invalid).pipe(Effect.flip);
      assert.include(failure.message, "invalid run plan");
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("offline mode preserves immutable execution identity", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const quickstartScenarioPath = paths.join(benchmarkRoot, "scenarios", "quickstart-to-delivery", "scenario.json");
      const sourcePath = paths.join(benchmarkRoot, "tests", "fixtures", "minimal-evidence-bundle.json");
      const source = yield* fileSystem.readFileString(sourcePath);
      const sourceObject = yield* Schema.decodeUnknownEffect(
        JsonObjectFromString,
      )(source);
      const frozenObject = yield* Schema.decodeUnknownEffect(
        EvidenceIdentitySchema,
      )(sourceObject);
      const plan: RunPlan = {
        ...planForFrozenEvidence("offline", frozenObject, quickstartScenarioPath),
        execution: {
          source_bundle_path: sourcePath,
          source_bundle_sha256: yield* sha256(source),
        },
      };
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const evidence = yield* runAttempt(yield* parseRunPlan(plan), paths.join(directory, "attempt"));
      assert.strictEqual(evidence.run_id, frozenObject.run_id);
      assert.notStrictEqual(evidence.run_id, plan.run_id);
      assert.strictEqual(evidence.mode, "conformance");
      assert.deepStrictEqual(evidence.evaluator, sourceObject.evaluator);
      assert.strictEqual(yield* fileSystem.readFileString(sourcePath), source);
      assert.isTrue(validateContract("evidence", evidence).valid);

      const invalid = { ...plan, execution: { ...plan.execution, command: ["subject-contact"] } };
      const failure = yield* parseRunPlan(invalid).pipe(Effect.flip);
      assert.include(failure.message, "invalid run plan");
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("offline mode emits source bytes unchanged", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const quickstartScenarioPath = paths.join(benchmarkRoot, "scenarios", "quickstart-to-delivery", "scenario.json");
      const fixturePath = paths.join(benchmarkRoot, "tests", "fixtures", "minimal-evidence-bundle.json");
      const fixtureObject = yield* readJson(fixturePath);
      const identity = yield* Schema.decodeUnknownEffect(EvidenceIdentitySchema)(fixtureObject);
      const canonical = yield* Schema.encodeEffect(JsonFromString)(fixtureObject);
      const source = ` \n${canonical}\t\n\n`;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const sourcePath = paths.join(directory, "noncanonical-frozen-evidence.json");
      yield* fileSystem.writeFileString(sourcePath, source);
      const plan: RunPlan = {
        ...planForFrozenEvidence("offline", identity, quickstartScenarioPath),
        execution: {
          source_bundle_path: sourcePath,
          source_bundle_sha256: yield* sha256(source),
        },
      };
      const runDirectory = paths.join(directory, "attempt");
      yield* runAttempt(yield* parseRunPlan(plan), runDirectory);
      assert.strictEqual(yield* fileSystem.readFileString(paths.join(runDirectory, "evidence.json")), source);
      assert.strictEqual(yield* fileSystem.readFileString(sourcePath), source);
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("emits schema-valid incomplete evidence on collection failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const benchmarkRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      const quickstartScenarioPath = paths.join(benchmarkRoot, "scenarios", "quickstart-to-delivery", "scenario.json");
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-runner-" });
      const plan: RunPlan = {
        ...basePlan("conformance", quickstartScenarioPath),
        execution: {
          collector: {
            interface: "synthetic failing collector",
            command: ["sh", "-c", "exit 7"],
          },
        },
      };
      const runDirectory = paths.join(directory, "attempt");
      const evidence = yield* runAttempt(yield* parseRunPlan(plan), runDirectory);
      assert.strictEqual(asObject(evidence.outcome)?.status, "incomplete");
      assert.isTrue(validateContract("evidence", evidence).valid);
      assert.isTrue(yield* fileSystem.exists(paths.join(runDirectory, "evidence.json")));
    })).pipe(Effect.provide(BunServices.layer)));
});
