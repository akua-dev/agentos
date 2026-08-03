import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  AGENTOS_RESILIENCE_EXECUTION_REFERENCES,
  ProtocolHardGateEvidenceV1Schema,
  WorkloadHardGateEvidenceV1Schema,
  compileExecutedAgentOSResilienceVerdict,
  validateHardGateRevision,
} from "./execution.ts";

const RunnerConfig = Config.all({
  repositoryRoot: Config.string("AGENTOS_REPOSITORY_ROOT"),
  context: Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT"),
  approvalReference: Config.string("AGENTOS_DISPOSABLE_FLEET_APPROVAL"),
  agentosImageDigest: Config.string(
    "AGENTOS_RESILIENCE_AGENTOS_IMAGE_DIGEST",
  ),
  agentgatewayImageDigest: Config.string(
    "AGENTOS_RESILIENCE_AGENTGATEWAY_IMAGE_DIGEST",
  ),
  openfgaImageDigest: Config.string(
    "AGENTOS_RESILIENCE_OPENFGA_IMAGE_DIGEST",
  ),
  postgresqlImageDigest: Config.string(
    "AGENTOS_RESILIENCE_POSTGRESQL_IMAGE_DIGEST",
  ),
  kubernetesNodeImageDigest: Config.string(
    "AGENTOS_RESILIENCE_KUBERNETES_NODE_IMAGE_DIGEST",
  ),
  bunExecutable: Config.string("AGENTOS_BUN_EXECUTABLE").pipe(
    Config.withDefault("bun"),
  ),
  gitExecutable: Config.string("AGENTOS_GIT_EXECUTABLE").pipe(
    Config.withDefault("git"),
  ),
  kubectlExecutable: Config.string("AGENTOS_KUBECTL_EXECUTABLE").pipe(
    Config.withDefault("kubectl"),
  ),
});

const RunnerErrorCodeSchema = Schema.Literals([
  "invalid_configuration",
  "process_spawn_failed",
  "process_failed",
  "report_unavailable",
  "report_invalid",
  "artifact_unavailable",
  "artifact_invalid",
  "artifact_drift",
  "namespace_cleanup_missing",
]);
const RunnerOperationSchema = Schema.Literals([
  "git_revision_before",
  "git_status_before",
  "test_execution",
  "namespace_cleanup",
  "git_revision_after",
  "git_status_after",
]);

export class ResilienceHardGateRunnerError extends Schema.TaggedErrorClass<ResilienceHardGateRunnerError>()(
  "ResilienceHardGateRunnerError",
  {
    code: RunnerErrorCodeSchema,
    operation: Schema.NullOr(RunnerOperationSchema),
    exitCode: Schema.NullOr(Schema.Number),
  },
) {}

type RunnerOperation = typeof RunnerOperationSchema.Type;

const runnerError = (
  code: typeof RunnerErrorCodeSchema.Type,
  operation: RunnerOperation | null = null,
  exitCode: number | null = null,
) => ResilienceHardGateRunnerError.make({ code, operation, exitCode });

const runCommand = Effect.fn("agentos.resilience.hardGate.command")(function*(
  operation: RunnerOperation,
  executable: string,
  arguments_: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly inheritStderr?: boolean;
  },
) {
  const child = yield* ChildProcess.make(executable, Array.from(arguments_), {
    cwd: options.cwd,
    env: options.environment,
    extendEnv: true,
    stderr: options.inheritStderr === true ? "inherit" : "ignore",
    stdout: "pipe",
  }).pipe(
    Effect.mapError(() => runnerError("process_spawn_failed", operation)),
  );
  const [exitCode, stdout] = yield* Effect.all([
    child.exitCode.pipe(Effect.map(Number)),
    child.stdout.pipe(Stream.decodeText(), Stream.mkString),
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError(() => runnerError("process_failed", operation)),
  );
  if (exitCode !== 0) {
    return yield* runnerError("process_failed", operation, exitCode);
  }
  return stdout.trim();
});

function executionFiles() {
  return AGENTOS_RESILIENCE_EXECUTION_REFERENCES
    .map(({ path }) => path)
    .filter((path, index, paths) => paths.indexOf(path) === index);
}

export const runAgentOSResilienceHardGate = Effect.fn(
  "agentos.resilience.hardGate.run",
)(function*() {
  const config = yield* RunnerConfig.pipe(
    Effect.mapError(() => runnerError("invalid_configuration")),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const repositoryRoot = paths.resolve(config.repositoryRoot);
  const beforeRevision = yield* runCommand(
    "git_revision_before",
    config.gitExecutable,
    ["rev-parse", "HEAD"],
    { cwd: repositoryRoot },
  );
  const beforePorcelain = yield* runCommand(
    "git_status_before",
    config.gitExecutable,
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repositoryRoot },
  );
  yield* validateHardGateRevision({
    beforeRevision,
    afterRevision: beforeRevision,
    porcelain: beforePorcelain,
    approvalReference: config.approvalReference,
  });

  const temporary = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-resilience-hard-gate-",
  });
  const reportPath = paths.join(temporary, "vitest-report.json");
  const workloadEvidencePath = paths.join(
    temporary,
    "workload-evidence.json",
  );
  const protocolEvidencePath = paths.join(
    temporary,
    "protocol-evidence.json",
  );
  yield* runCommand(
    "test_execution",
    config.bunExecutable,
    [
      paths.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--no-file-parallelism",
      ...executionFiles(),
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: repositoryRoot,
      environment: {
        AGENTOS_RESILIENCE_HARD_GATE: "true",
        AGENTOS_KUBERNETES_TEST_CONTEXT: config.context,
        AGENTOS_DISPOSABLE_FLEET_APPROVAL: config.approvalReference,
        AGENTOS_RESILIENCE_WORKLOAD_EVIDENCE_PATH: workloadEvidencePath,
        AGENTOS_RESILIENCE_PROTOCOL_EVIDENCE_PATH: protocolEvidencePath,
      },
      inheritStderr: true,
    },
  );
  const reportSource = yield* fileSystem.readFileString(reportPath).pipe(
    Effect.mapError(() => runnerError("report_unavailable")),
  );
  const report = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(reportSource).pipe(
    Effect.mapError(() => runnerError("report_invalid")),
  );
  const [workloadEvidenceSource, protocolEvidenceSource] = yield* Effect.all([
    fileSystem.readFileString(workloadEvidencePath),
    fileSystem.readFileString(protocolEvidencePath),
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError(() => runnerError("artifact_unavailable")),
  );
  const [workloadEvidence, protocolEvidence] = yield* Effect.all([
    Schema.decodeUnknownEffect(
      Schema.fromJsonString(WorkloadHardGateEvidenceV1Schema),
    )(workloadEvidenceSource),
    Schema.decodeUnknownEffect(
      Schema.fromJsonString(ProtocolHardGateEvidenceV1Schema),
    )(protocolEvidenceSource),
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError(() => runnerError("artifact_invalid")),
  );
  if (
    workloadEvidence.context !== config.context ||
    workloadEvidence.approvalReference !== config.approvalReference ||
    protocolEvidence.context !== config.context ||
    protocolEvidence.approvalReference !== config.approvalReference
  ) return yield* runnerError("artifact_drift");

  const namespaces = yield* runCommand(
    "namespace_cleanup",
    config.kubectlExecutable,
    [
      "--context",
      config.context,
      "get",
      "namespaces",
      "--output=name",
    ],
    { cwd: repositoryRoot },
  );
  if (
    namespaces.split("\n").some((namespace) =>
      namespace.includes("agentos-workload-") ||
      namespace.includes("agentos-protocol-")
    )
  ) {
    return yield* runnerError(
      "namespace_cleanup_missing",
      "namespace_cleanup",
    );
  }

  const afterRevision = yield* runCommand(
    "git_revision_after",
    config.gitExecutable,
    ["rev-parse", "HEAD"],
    { cwd: repositoryRoot },
  );
  const afterPorcelain = yield* runCommand(
    "git_status_after",
    config.gitExecutable,
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repositoryRoot },
  );
  const revision = yield* validateHardGateRevision({
    beforeRevision,
    afterRevision,
    porcelain: afterPorcelain,
    approvalReference: config.approvalReference,
  });
  const compiled = yield* compileExecutedAgentOSResilienceVerdict({
    repositoryRoot,
    hardGate: true,
    revision,
    environment: {
      isolation: "disposable",
      context: config.context,
      approvalReference: config.approvalReference,
      productionEndpointContacted: false,
      destroyedAfterRun: true,
    },
    images: [
      { name: "agentos", digest: config.agentosImageDigest },
      { name: "agentgateway", digest: config.agentgatewayImageDigest },
      { name: "openfga", digest: config.openfgaImageDigest },
      { name: "postgresql", digest: config.postgresqlImageDigest },
      {
        name: "kubernetes-node",
        digest: config.kubernetesNodeImageDigest,
      },
    ],
    workloadSpecDigest: workloadEvidence.interactiveSpecDigest,
    renderDigest: workloadEvidence.interactiveRenderDigest,
    protocolRevocationMillis: protocolEvidence.revocationMillis,
    report,
  });
  return {
    revision,
    namespaceCleanupObserved: true,
    ...compiled,
  };
});

export const agentOSResilienceHardGate = runAgentOSResilienceHardGate().pipe(
  Effect.scoped,
);
