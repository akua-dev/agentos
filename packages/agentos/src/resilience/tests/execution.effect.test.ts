import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Path } from "effect";

import {
  AGENTOS_RESILIENCE_EXECUTION_REFERENCES,
  ResilienceExecutionError,
  compileExecutedAgentOSResilienceVerdict,
  resolveHardGateArtifactPath,
  resolveDisposableProofOptions,
  validateHardGateRevision,
  verifyResilienceTestExecution,
} from "../execution.ts";

const platform = Layer.mergeAll(BunServices.layer);
const repositoryRoot = "/workspace/agentos";
const repositoryRootUrl = new URL("../../../../../", import.meta.url);
const reference = {
  path: "packages/agentos/src/workloads/tests/disposable-recovery.effect.test.ts",
  title:
    "proves fresh and retained Mate/Crewmate lifecycle, quota, affinity, Secret modes, and repair",
};

function report(
  status = "passed",
  path = `${repositoryRoot}/${reference.path}`,
) {
  return {
    success: status === "passed",
    numFailedTests: status === "failed" ? 1 : 0,
    testResults: [{
      name: path,
      status,
      assertionResults: [{
        title: reference.title,
        fullName: `disposable typed workload recovery ${reference.title}`,
        status,
        failureMessages: [],
      }],
    }],
  };
}

function completeExecutionReport(root: string) {
  return {
    numTotalTestSuites: AGENTOS_RESILIENCE_EXECUTION_REFERENCES.length,
    success: true,
    numFailedTests: 0,
    testResults: AGENTOS_RESILIENCE_EXECUTION_REFERENCES.map((item) => ({
      name: `${root}/${item.path}`,
      status: "passed",
      startTime: 1_785_716_626_226,
      assertionResults: [{
        title: item.title,
        fullName: item.title,
        status: "passed",
        failureMessages: [],
      }],
    })),
  };
}

function metadata(root: string) {
  return {
    repositoryRoot: root,
    hardGate: true,
    revision: "a".repeat(40),
    environment: {
      isolation: "disposable",
      context: "kind-agentos-resilience-84",
      approvalReference: "approval:issue-84",
      productionEndpointContacted: false,
      destroyedAfterRun: true,
    },
    images: [
      { name: "agentos", digest: `sha256:${"a".repeat(64)}` },
      { name: "agentgateway", digest: `sha256:${"b".repeat(64)}` },
      { name: "openfga", digest: `sha256:${"c".repeat(64)}` },
      { name: "postgresql", digest: `sha256:${"d".repeat(64)}` },
      { name: "kubernetes-node", digest: `sha256:${"e".repeat(64)}` },
    ],
    workloadSpecDigest: `sha256:${"f".repeat(64)}`,
    renderDigest: `sha256:${"0".repeat(64)}`,
    protocolRevocationMillis: 15_000,
    report: completeExecutionReport(root),
  };
}

layer(platform)("resilience execution attestation", (it) => {
  it.effect("accepts only exact passed Effect regression assertions", () =>
    Effect.gen(function*() {
      const proof = yield* verifyResilienceTestExecution({
        repositoryRoot,
        hardGate: true,
        report: report(),
        references: [reference],
      });
      assert.deepStrictEqual(proof, {
        version: 1,
        hardGate: true,
        passedAssertionCount: 1,
        referencedFileCount: 1,
      });
    }));

  it.effect("rejects failed, missing, duplicate, and outside-repository assertions", () =>
    Effect.gen(function*() {
      const failed = yield* verifyResilienceTestExecution({
        repositoryRoot,
        hardGate: true,
        report: report("failed"),
        references: [reference],
      }).pipe(Effect.flip);
      assert.instanceOf(failed, ResilienceExecutionError);
      assert.strictEqual(failed.code, "test_run_failed");

      const missing = yield* verifyResilienceTestExecution({
        repositoryRoot,
        hardGate: true,
        report: report(),
        references: [{ ...reference, title: "missing proof" }],
      }).pipe(Effect.flip);
      assert.strictEqual(missing.code, "assertion_missing");

      const duplicateReport = report();
      duplicateReport.testResults = duplicateReport.testResults.map((result) => ({
        ...result,
        assertionResults: [
          ...result.assertionResults,
          ...result.assertionResults,
        ],
      }));
      const duplicate = yield* verifyResilienceTestExecution({
        repositoryRoot,
        hardGate: true,
        report: duplicateReport,
        references: [reference],
      }).pipe(Effect.flip);
      assert.strictEqual(duplicate.code, "assertion_duplicate");

      const escaped = yield* verifyResilienceTestExecution({
        repositoryRoot,
        hardGate: true,
        report: report("passed", "/tmp/forged.effect.test.ts"),
        references: [reference],
      }).pipe(Effect.flip);
      assert.strictEqual(escaped.code, "test_file_outside_repository");
    }));

  it.effect("fails closed when hard mode lacks disposable context or approval", () =>
    Effect.gen(function*() {
      const ordinary = yield* resolveDisposableProofOptions({
        hardGate: false,
        context: null,
        approvalReference: null,
      });
      assert.isTrue(Option.isNone(ordinary));

      const missing = yield* resolveDisposableProofOptions({
        hardGate: true,
        context: null,
        approvalReference: "approval:issue-84",
      }).pipe(Effect.flip);
      assert.instanceOf(missing, ResilienceExecutionError);
      assert.strictEqual(missing.code, "hard_gate_configuration_missing");

      const configured = yield* resolveDisposableProofOptions({
        hardGate: true,
        context: "kind-agentos-resilience-84",
        approvalReference: "approval:issue-84",
      });
      assert.deepStrictEqual(configured, Option.some({
        context: "kind-agentos-resilience-84",
        approvalReference: "approval:issue-84",
      }));

      assert.isTrue(Option.isNone(yield* resolveHardGateArtifactPath({
        hardGate: false,
        path: null,
      })));
      const missingArtifact = yield* resolveHardGateArtifactPath({
        hardGate: true,
        path: null,
      }).pipe(Effect.flip);
      assert.strictEqual(missingArtifact.code, "hard_gate_artifact_missing");
      assert.deepStrictEqual(
        yield* resolveHardGateArtifactPath({
          hardGate: true,
          path: "/tmp/resilience-evidence.json",
        }),
        Option.some("/tmp/resilience-evidence.json"),
      );
    }));

  it.effect("compiles the parent verdict only from an exact executed regression matrix", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const root = paths.resolve(yield* paths.fromFileUrl(repositoryRootUrl));
      const result = yield* compileExecutedAgentOSResilienceVerdict(metadata(root));
      assert.strictEqual(result.verdict.eligible, true);
      assert.strictEqual(result.verdict.revision, "a".repeat(40));
      assert.strictEqual(
        result.execution.passedAssertionCount,
        AGENTOS_RESILIENCE_EXECUTION_REFERENCES.length,
      );

      const missing = metadata(root);
      missing.report.testResults = missing.report.testResults.slice(1);
      const failure = yield* compileExecutedAgentOSResilienceVerdict(
        missing,
      ).pipe(Effect.flip);
      assert.instanceOf(failure, ResilienceExecutionError);
      assert.strictEqual(failure.code, "assertion_missing");
    }));

  it.effect("binds approval, clean checkout, and post-run HEAD to one revision", () =>
    Effect.gen(function*() {
      const revision = "a".repeat(40);
      assert.strictEqual(
        yield* validateHardGateRevision({
          beforeRevision: revision,
          afterRevision: revision,
          porcelain: "",
          approvalReference: `approval:issue-84-${revision}`,
        }),
        revision,
      );

      const dirty = yield* validateHardGateRevision({
        beforeRevision: revision,
        afterRevision: revision,
        porcelain: " M packages/agentos/src/index.ts",
        approvalReference: `approval:issue-84-${revision}`,
      }).pipe(Effect.flip);
      assert.strictEqual(dirty.code, "working_tree_dirty");

      const unapproved = yield* validateHardGateRevision({
        beforeRevision: revision,
        afterRevision: revision,
        porcelain: "",
        approvalReference: "approval:issue-84-wrong-revision",
      }).pipe(Effect.flip);
      assert.strictEqual(unapproved.code, "revision_approval_mismatch");

      const changed = yield* validateHardGateRevision({
        beforeRevision: revision,
        afterRevision: "b".repeat(40),
        porcelain: "",
        approvalReference: `approval:issue-84-${revision}`,
      }).pipe(Effect.flip);
      assert.strictEqual(changed.code, "revision_changed");
    }));
});
