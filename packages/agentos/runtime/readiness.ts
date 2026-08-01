import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Option, Schema } from "effect";

import {
  CODEX_GATEWAY_PROVIDER_ID,
  codexGatewayProviderEntry,
} from "./codex-provider.ts";

const AgentRole = Schema.Literals([
  "crewmate",
  "first_mate",
  "second_mate",
  "unknown",
]);
const HealthMode = Schema.Literals(["live", "ready"]);
const HealthStatus = Schema.Literals([
  "degraded",
  "live",
  "not_live",
  "not_ready",
  "ready",
]);
const CheckComponent = Schema.Literals([
  "agent",
  "assignment",
  "brief",
  "confirmation",
  "coordination",
  "credential",
  "database",
  "harness",
  "herdr",
  "provider",
  "session",
]);
const CheckStatus = Schema.Literals(["degraded", "fail", "pass"]);
const ReasonCode = Schema.Literals([
  "agent_ambiguous",
  "agent_blocked",
  "agent_cwd_mismatch",
  "agent_missing",
  "agent_observation_invalid",
  "assignment_identity_invalid",
  "brief_digest_invalid",
  "brief_digest_mismatch",
  "brief_missing",
  "coordination_catchup_incomplete",
  "coordination_listener_missing",
  "crewmate_confirmation_invalid",
  "crewmate_confirmation_missing",
  "database_credential_unavailable",
  "database_identity_invalid",
  "database_identity_mismatch",
  "database_identity_unconfigured",
  "harness_mismatch",
  "harness_observation_invalid",
  "herdr_unavailable",
  "pane_process_unavailable",
  "provider_configuration_invalid",
  "provider_credential_unavailable",
  "provider_credential_unknown",
  "runtime_configuration_invalid",
  "session_cwd_mismatch",
  "session_invalid",
  "session_missing",
]);
const HealthReason = Schema.Struct({
  code: ReasonCode,
  component: CheckComponent,
});
const HealthCheck = Schema.Struct({
  component: CheckComponent,
  status: CheckStatus,
});

export const SemanticHealthDiagnostic = Schema.Struct({
  checks: Schema.Array(HealthCheck),
  mode: HealthMode,
  reasons: Schema.Array(HealthReason),
  role: AgentRole,
  status: HealthStatus,
  version: Schema.Literal(1),
});

const HerdrAgentSession = Schema.Struct({
  kind: Schema.String,
  value: Schema.String,
});
const HerdrAgent = Schema.Struct({
  agent_session: Schema.optionalKey(HerdrAgentSession),
  agent_status: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  foreground_cwd: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  pane_id: Schema.optionalKey(Schema.String),
});
const HerdrAgentList = Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(HerdrAgent) }),
});
const HerdrStatus = Schema.Struct({
  result: Schema.Struct({ running: Schema.Literal(true) }),
});
const HerdrExplanation = Schema.Struct({
  agent: Schema.String,
  state: Schema.String,
});
const ForegroundProcess = Schema.Struct({
  argv0: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  pid: Schema.Number,
});
const HerdrProcessInfo = Schema.Struct({
  result: Schema.Struct({
    process_info: Schema.Struct({
      foreground_process_group_id: Schema.Number,
      foreground_processes: Schema.Array(ForegroundProcess),
      pane_id: Schema.String,
    }),
  }),
});
const PiProviderReadiness = Schema.Struct({
  files: Schema.Struct({
    markerSha256: Schema.NullOr(Schema.String),
    modelsSha256: Schema.NullOr(Schema.String),
    settingsSha256: Schema.NullOr(Schema.String),
  }),
  mode: Schema.Literals(["ai_gateway", "direct"]),
  selectedModel: Schema.NullOr(Schema.String),
  selectedThinking: Schema.NullOr(Schema.String),
  version: Schema.Literal(1),
});
const CoordinationReadiness = Schema.Struct({
  agentName: Schema.String,
  herdrSession: Schema.String,
  listenerProcessId: Schema.Number,
  listenerTaskId: Schema.String,
  ownerProcessId: Schema.Number,
  phase: Schema.Literals(["caught_up", "listening"]),
  version: Schema.Literal(1),
});
const CrewmateReadiness = Schema.Struct({
  agentId: Schema.String,
  assignmentId: Schema.String,
  briefSha256: Schema.String,
  harness: Schema.String,
  herdrSession: Schema.String,
  processId: Schema.Number,
  taskId: Schema.String,
  version: Schema.Literal(1),
});

type Diagnostic = typeof SemanticHealthDiagnostic.Type;
type Role = typeof AgentRole.Type;
type Check = typeof HealthCheck.Type;
type Component = typeof CheckComponent.Type;
type Reason = typeof HealthReason.Type;
type ReasonCode = typeof ReasonCode.Type;
type ForegroundProcess = typeof ForegroundProcess.Type;

export type HealthEnvironment = Readonly<Record<string, string | undefined>>;
export type HealthCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
};
export type HealthFileMetadata = {
  readonly isFile: boolean;
  readonly mode: number;
  readonly size: number;
};
export type SemanticHealthRuntime = {
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<HealthCommandResult>;
  readonly readText: (
    path: string,
    maximumBytes: number,
  ) => Effect.Effect<string | undefined>;
  readonly readFirstLine: (
    path: string,
    maximumBytes: number,
  ) => Effect.Effect<string | undefined>;
  readonly metadata: (
    path: string,
  ) => Effect.Effect<HealthFileMetadata | undefined>;
  readonly processExists: (processId: number) => Effect.Effect<boolean>;
};

type Evaluation = {
  checks: Check[];
  reasons: Reason[];
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const maximumConfigurationBytes = 1024 * 1024;
const maximumBriefBytes = 1024 * 1024;
const maximumStateBytes = 64 * 1024;
const maximumSessionHeaderBytes = 4 * 1024;
const maximumProjectedTokenBytes = 16 * 1024;
const defaultEgressTokenPath = "/var/run/secrets/agentos-egress/token";

function requiredEnvironment(
  environment: HealthEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function roleFromEnvironment(environment: HealthEnvironment): Role {
  const decoded = Schema.decodeUnknownOption(AgentRole)(
    requiredEnvironment(environment, "AGENTOS_AGENT_ROLE"),
  );
  return Option.getOrElse(decoded, () => "unknown");
}

function addCheck(
  evaluation: Evaluation,
  component: Component,
  status: Check["status"],
  code?: ReasonCode,
): void {
  evaluation.checks.push({ component, status });
  if (code !== undefined) evaluation.reasons.push({ code, component });
}

function diagnostic(
  role: Role,
  mode: "live" | "ready",
  evaluation: Evaluation,
): Diagnostic {
  const failed = evaluation.checks.some(({ status }) => status === "fail");
  const degraded = evaluation.checks.some(
    ({ status }) => status === "degraded",
  );
  const status: Diagnostic["status"] =
    mode === "live"
      ? failed
        ? "not_live"
        : "live"
      : failed
        ? "not_ready"
        : degraded
          ? "degraded"
          : "ready";
  return {
    checks: evaluation.checks,
    mode,
    reasons: evaluation.reasons,
    role,
    status,
    version: 1,
  };
}

function parseUnknownJson(source: string): unknown | undefined {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function parseUnknownToml(source: string): unknown | undefined {
  try {
    return Bun.TOML.parse(source);
  } catch {
    return undefined;
  }
}

function objectRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function decodeSource<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string | undefined,
): S["Type"] | undefined {
  if (source === undefined) return undefined;
  const parsed = parseUnknownJson(source);
  if (parsed === undefined) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(parsed));
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function isPrivateRegularFile(
  metadata: HealthFileMetadata | undefined,
): boolean {
  return (
    metadata !== undefined &&
    metadata.isFile &&
    metadata.size > 0 &&
    (metadata.mode & 0o077) === 0
  );
}

function sessionHeader(source: string | undefined) {
  if (source === undefined) return undefined;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseUnknownJson(line);
    if (parsed === undefined) continue;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({
        cwd: Schema.String,
        id: Schema.String,
        type: Schema.Literal("session"),
      }),
    )(parsed);
    return Option.getOrUndefined(decoded);
  }
  return undefined;
}

function expectedHarness(role: Role, environment: HealthEnvironment) {
  return role === "crewmate"
    ? requiredEnvironment(environment, "AGENTOS_HARNESS")
    : "pi";
}

function foregroundProcess(
  processes: ReadonlyArray<ForegroundProcess>,
  harness: string,
): ForegroundProcess | undefined {
  return processes.find(({ argv0 }) => basename(argv0) === harness);
}

function gatewayMetadataValid(environment: HealthEnvironment): boolean {
  const rawUrl = requiredEnvironment(environment, "AI_GATEWAY_URL");
  if (rawUrl === undefined) return false;
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isSecureProjectedToken(
  metadata: HealthFileMetadata | undefined,
): boolean {
  return (
    metadata !== undefined &&
    metadata.isFile &&
    metadata.size > 0 &&
    metadata.size <= maximumProjectedTokenBytes &&
    (metadata.mode & 0o400) !== 0 &&
    (metadata.mode & 0o027) === 0
  );
}

const verifyProvider = Effect.fn("agentos.readiness.verifyProvider")(
  function*(
    environment: HealthEnvironment,
    probeRuntime: SemanticHealthRuntime,
    home: string,
    evaluation: Evaluation,
  ) {
    const piDirectory =
      requiredEnvironment(environment, "PI_CODING_AGENT_DIR") ??
      join(home, ".pi", "agent");
    const statePath = join(
      home,
      ".local",
      "state",
      "agentos",
      "pi-provider-readiness.json",
    );
    const attestation = decodeSource(
      PiProviderReadiness,
      yield* probeRuntime.readText(statePath, maximumStateBytes),
    );
    const configuredModeRaw =
      requiredEnvironment(environment, "AGENTOS_PI_PROVIDER_MODE") ?? "direct";
    const configuredMode =
      configuredModeRaw === "ai-gateway" ? "ai_gateway" : configuredModeRaw;
    const selectedModel =
      requiredEnvironment(environment, "AGENTOS_MODEL") ?? null;
    const selectedThinking =
      requiredEnvironment(environment, "AGENTOS_THINKING") ?? null;
    let configurationValid =
      attestation !== undefined &&
      attestation.mode === configuredMode &&
      attestation.selectedModel === selectedModel &&
      attestation.selectedThinking === selectedThinking;

    if (configurationValid && attestation !== undefined) {
      const paths = [
        ["settingsSha256", join(piDirectory, "settings.json")],
        ["modelsSha256", join(piDirectory, "models.json")],
        [
          "markerSha256",
          join(home, ".local", "state", "agentos", "pi-provider.json"),
        ],
      ] as const;
      for (const [key, path] of paths) {
        const source = yield* probeRuntime.readText(
          path,
          maximumConfigurationBytes,
        );
        const expected = attestation.files[key];
        if (
          (expected === null && source !== undefined) ||
          (expected !== null &&
            (source === undefined || sha256(source) !== expected))
        ) {
          configurationValid = false;
        }
      }
    }
    addCheck(
      evaluation,
      "provider",
      configurationValid ? "pass" : "fail",
      configurationValid ? undefined : "provider_configuration_invalid",
    );
  },
);

const verifyCredential = Effect.fn("agentos.readiness.verifyCredential")(
  function*(
    role: Role,
    environment: HealthEnvironment,
    probeRuntime: SemanticHealthRuntime,
    home: string,
    evaluation: Evaluation,
  ) {
    const kind =
      requiredEnvironment(environment, "AGENTOS_PROVIDER_CREDENTIAL_KIND") ??
      (requiredEnvironment(environment, "AGENTOS_PI_PROVIDER_MODE") ===
      "ai-gateway"
        ? "ai_gateway"
        : role === "crewmate"
          ? "codex_auth"
          : "pi_auth");
    let available: boolean;
    if (kind === "ai_gateway") {
      const tokenPath =
        requiredEnvironment(environment, "AGENTOS_EGRESS_TOKEN_FILE") ??
        defaultEgressTokenPath;
      available =
        gatewayMetadataValid(environment) &&
        isSecureProjectedToken(yield* probeRuntime.metadata(tokenPath));
    } else if (kind === "pi_auth") {
      const directory =
        requiredEnvironment(environment, "PI_CODING_AGENT_DIR") ??
        join(home, ".pi", "agent");
      available = isPrivateRegularFile(
        yield* probeRuntime.metadata(join(directory, "auth.json")),
      );
    } else if (kind === "codex_auth") {
      const directory =
        requiredEnvironment(environment, "CODEX_HOME") ??
        join(home, ".codex");
      available = isPrivateRegularFile(
        yield* probeRuntime.metadata(join(directory, "auth.json")),
      );
    } else {
      addCheck(evaluation, "credential", "fail", "provider_credential_unknown");
      return;
    }
    addCheck(
      evaluation,
      "credential",
      available ? "pass" : "fail",
      available ? undefined : "provider_credential_unavailable",
    );
  },
);

const verifyCodexGatewayProvider = Effect.fn(
  "agentos.readiness.verifyCodexGatewayProvider",
)(function*(
  environment: HealthEnvironment,
  probeRuntime: SemanticHealthRuntime,
  home: string,
  evaluation: Evaluation,
) {
  if (
    requiredEnvironment(environment, "AGENTOS_CODEX_PROVIDER_MODE") !==
      "ai-gateway"
  ) {
    return;
  }
  const codexHome =
    requiredEnvironment(environment, "CODEX_HOME") ?? join(home, ".codex");
  const configPath = join(codexHome, "config.toml");
  const markerPath = join(
    home,
    ".local",
    "state",
    "agentos",
    "codex-provider.json",
  );
  const [source, markerSource, metadata] = yield* Effect.all([
    probeRuntime.readText(configPath, maximumConfigurationBytes),
    probeRuntime.readText(markerPath, maximumStateBytes),
    probeRuntime.metadata(configPath),
  ]);
  const config = source === undefined
    ? undefined
    : objectRecord(parseUnknownToml(source));
  const providers = objectRecord(config?.model_providers);
  const entry = objectRecord(providers?.[CODEX_GATEWAY_PROVIDER_ID]);
  const marker = markerSource === undefined
    ? undefined
    : objectRecord(parseUnknownJson(markerSource));
  let expected: Readonly<Record<string, unknown>> | undefined;
  try {
    expected = codexGatewayProviderEntry(environment);
  } catch {
    expected = undefined;
  }
  const configurationValid =
    isPrivateRegularFile(metadata) &&
    config?.model_provider === CODEX_GATEWAY_PROVIDER_ID &&
    expected !== undefined &&
    isDeepStrictEqual(entry, expected) &&
    marker?._tag === "Active" &&
    marker.version === 1 &&
    isDeepStrictEqual(objectRecord(marker.entry), expected);
  addCheck(
    evaluation,
    "provider",
    configurationValid ? "pass" : "fail",
    configurationValid ? undefined : "provider_configuration_invalid",
  );
});

const verifyDatabase = Effect.fn(
  "agentos.readiness.verifyDatabase",
)(function*(
  environment: HealthEnvironment,
  probeRuntime: SemanticHealthRuntime,
  home: string,
  evaluation: Evaluation,
  requiredForRole: boolean,
) {
  const rawUrl =
    requiredEnvironment(environment, "AGENTOS_DATABASE_URL") ??
    requiredEnvironment(environment, "DATABASE_URL");
  if (rawUrl === undefined) {
    if (requiredForRole) {
      addCheck(
        evaluation,
        "database",
        "fail",
        "database_identity_unconfigured",
      );
    }
    return;
  }

  const expectedIdentity = requiredEnvironment(
    environment,
    "AGENTOS_DATABASE_IDENTITY",
  );
  if (expectedIdentity === undefined) {
    addCheck(
      evaluation,
      "database",
      "fail",
      "database_identity_unconfigured",
    );
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
      parsed.password
    ) {
      addCheck(evaluation, "database", "fail", "database_identity_invalid");
    } else if (decodeURIComponent(parsed.username) !== expectedIdentity) {
      addCheck(evaluation, "database", "fail", "database_identity_mismatch");
    } else {
      const credentialPath =
        requiredEnvironment(environment, "PGPASSFILE") ?? join(home, ".pgpass");
      const metadata = yield* probeRuntime.metadata(credentialPath);
      addCheck(
        evaluation,
        "database",
        isPrivateRegularFile(metadata) ? "pass" : "fail",
        isPrivateRegularFile(metadata)
          ? undefined
          : "database_credential_unavailable",
      );
    }
  }
});

const verifyCoordination = Effect.fn(
  "agentos.readiness.verifyCoordination",
)(function*(
  environment: HealthEnvironment,
  probeRuntime: SemanticHealthRuntime,
  home: string,
  processId: number,
  evaluation: Evaluation,
) {
  const markerPath = join(
    home,
    ".local",
    "state",
    "agentos",
    "readiness",
    "coordination.json",
  );
  const marker = decodeSource(
    CoordinationReadiness,
    yield* probeRuntime.readText(markerPath, maximumStateBytes),
  );
  const agentName = requiredEnvironment(environment, "AGENTOS_AGENT_NAME");
  const herdrSession = requiredEnvironment(environment, "HERDR_SESSION");
  const listenerProcessAvailable =
    marker !== undefined &&
    Number.isSafeInteger(marker.listenerProcessId) &&
    marker.listenerProcessId > 0 &&
    (yield* probeRuntime.processExists(marker.listenerProcessId));
  if (
    marker === undefined ||
    marker.agentName !== agentName ||
    marker.herdrSession !== herdrSession ||
    marker.ownerProcessId !== processId ||
    !listenerProcessAvailable
  ) {
    addCheck(
      evaluation,
      "coordination",
      "fail",
      "coordination_listener_missing",
    );
  } else if (marker.phase !== "caught_up") {
    addCheck(
      evaluation,
      "coordination",
      "fail",
      "coordination_catchup_incomplete",
    );
  } else {
    addCheck(evaluation, "coordination", "pass");
  }
});

const verifyCrewmate = Effect.fn("agentos.readiness.verifyCrewmate")(
  function*(
    environment: HealthEnvironment,
    probeRuntime: SemanticHealthRuntime,
    home: string,
    processId: number,
    harness: string | undefined,
    evaluation: Evaluation,
  ) {
    const agentId = requiredEnvironment(environment, "AGENTOS_AGENT_ID");
    const assignmentId = requiredEnvironment(
      environment,
      "AGENTOS_ASSIGNMENT_ID",
    );
    const taskId = requiredEnvironment(environment, "AGENTOS_TASK_ID");
    const identitiesValid = [agentId, assignmentId, taskId].every(
      (value) => value !== undefined && uuidPattern.test(value),
    );
    addCheck(
      evaluation,
      "assignment",
      identitiesValid ? "pass" : "fail",
      identitiesValid ? undefined : "assignment_identity_invalid",
    );

    const briefPath = requiredEnvironment(environment, "AGENTOS_BRIEF_PATH");
    const expectedDigest = requiredEnvironment(
      environment,
      "AGENTOS_BRIEF_SHA256",
    );
    let observedDigest: string | undefined;
    if (expectedDigest === undefined || !digestPattern.test(expectedDigest)) {
      addCheck(evaluation, "brief", "fail", "brief_digest_invalid");
    } else if (briefPath === undefined) {
      addCheck(evaluation, "brief", "fail", "brief_missing");
    } else {
      const metadata = yield* probeRuntime.metadata(briefPath);
      if (
        metadata === undefined ||
        !metadata.isFile ||
        metadata.size <= 0 ||
        metadata.size > maximumBriefBytes
      ) {
        addCheck(evaluation, "brief", "fail", "brief_missing");
      } else {
        const source = yield* probeRuntime.readText(briefPath, maximumBriefBytes);
        observedDigest = source === undefined ? undefined : sha256(source);
        addCheck(
          evaluation,
          "brief",
          observedDigest === expectedDigest ? "pass" : "fail",
          observedDigest === expectedDigest
            ? undefined
            : "brief_digest_mismatch",
        );
      }
    }

    const markerPath = join(
      home,
      ".local",
      "state",
      "agentos",
      "readiness",
      "crewmate.json",
    );
    const source = yield* probeRuntime.readText(markerPath, maximumStateBytes);
    const marker = decodeSource(CrewmateReadiness, source);
    if (source === undefined) {
      addCheck(
        evaluation,
        "confirmation",
        "fail",
        "crewmate_confirmation_missing",
      );
    } else if (
      marker === undefined ||
      marker.agentId !== agentId ||
      marker.assignmentId !== assignmentId ||
      marker.taskId !== taskId ||
      marker.briefSha256 !== observedDigest ||
      marker.harness !== harness ||
      marker.herdrSession !==
        requiredEnvironment(environment, "HERDR_SESSION") ||
      marker.processId !== processId
    ) {
      addCheck(
        evaluation,
        "confirmation",
        "fail",
        "crewmate_confirmation_invalid",
      );
    } else {
      addCheck(evaluation, "confirmation", "pass");
    }
  },
);

export const evaluateSemanticHealth = Effect.fn(
  "agentos.readiness.evaluate",
)(function*(
  environment: HealthEnvironment,
  mode: "live" | "ready",
  probeRuntime: SemanticHealthRuntime,
) {
  const role = roleFromEnvironment(environment);
  const evaluation: Evaluation = { checks: [], reasons: [] };
  const session =
    requiredEnvironment(environment, "HERDR_SESSION") ??
    `agentos-${requiredEnvironment(environment, "AGENTOS_AGENT_NAME") ?? "agent"}`;
  const status = yield* probeRuntime.run([
    "herdr",
    "status",
    "--json",
    "--session",
    session,
  ]);
  const herdrStatus = decodeSource(
    HerdrStatus,
    status.exitCode === 0 ? status.stdout : undefined,
  );
  if (herdrStatus === undefined) {
    addCheck(evaluation, "herdr", "fail", "herdr_unavailable");
    return diagnostic(role, mode, evaluation);
  }
  addCheck(evaluation, "herdr", "pass");
  if (mode === "live") return diagnostic(role, mode, evaluation);
  if (role === "unknown") {
    addCheck(
      evaluation,
      "agent",
      "fail",
      "runtime_configuration_invalid",
    );
    return diagnostic(role, mode, evaluation);
  }

  const agentName = requiredEnvironment(environment, "AGENTOS_AGENT_NAME");
  const expectedCwd = requiredEnvironment(environment, "AGENTOS_AGENT_CWD");
  const listResult = yield* probeRuntime.run([
    "herdr",
    "agent",
    "list",
    "--session",
    session,
  ]);
  const list = decodeSource(
    HerdrAgentList,
    listResult.exitCode === 0 ? listResult.stdout : undefined,
  );
  if (list === undefined) {
    addCheck(
      evaluation,
      "agent",
      "fail",
      "agent_observation_invalid",
    );
    return diagnostic(role, mode, evaluation);
  }
  const matches = list.result.agents.filter(({ name }) => name === agentName);
  if (matches.length === 0) {
    addCheck(evaluation, "agent", "fail", "agent_missing");
    return diagnostic(role, mode, evaluation);
  }
  if (matches.length !== 1) {
    addCheck(evaluation, "agent", "fail", "agent_ambiguous");
    return diagnostic(role, mode, evaluation);
  }
  const agent = matches[0];
  if (agent === undefined) {
    addCheck(evaluation, "agent", "fail", "agent_missing");
    return diagnostic(role, mode, evaluation);
  }
  if (
    expectedCwd === undefined ||
    (agent.foreground_cwd ?? agent.cwd) !== expectedCwd
  ) {
    addCheck(evaluation, "agent", "fail", "agent_cwd_mismatch");
  } else {
    addCheck(evaluation, "agent", "pass");
  }

  const paneId = agent.pane_id;
  const harness = expectedHarness(role, environment);
  const [explanationResult, processResult] = yield* Effect.all([
    probeRuntime.run([
      "herdr",
      "agent",
      "explain",
      agentName ?? "agent",
      "--json",
      "--session",
      session,
    ]),
    paneId === undefined
      ? Effect.succeed({ exitCode: 1, stdout: "" })
      : probeRuntime.run([
          "herdr",
          "pane",
          "process-info",
          "--pane",
          paneId,
          "--session",
          session,
        ]),
  ]);
  const explanation = decodeSource(
    HerdrExplanation,
    explanationResult.exitCode === 0 ? explanationResult.stdout : undefined,
  );
  const processInfo = decodeSource(
    HerdrProcessInfo,
    processResult.exitCode === 0 ? processResult.stdout : undefined,
  );
  if (explanation === undefined) {
    addCheck(
      evaluation,
      "harness",
      "fail",
      "harness_observation_invalid",
    );
  }
  if (processInfo === undefined) {
    addCheck(
      evaluation,
      "harness",
      "fail",
      "pane_process_unavailable",
    );
    return diagnostic(role, mode, evaluation);
  }
  const process =
    harness === undefined
      ? undefined
      : foregroundProcess(
          processInfo.result.process_info.foreground_processes,
          harness,
        );
  const harnessMatches =
    explanation !== undefined &&
    harness !== undefined &&
    explanation.agent === harness &&
    process !== undefined &&
    process.cwd === expectedCwd;
  if (explanation !== undefined) {
    addCheck(
      evaluation,
      "harness",
      harnessMatches
        ? explanation.state === "blocked"
          ? "degraded"
          : "pass"
        : "fail",
      harnessMatches
        ? explanation.state === "blocked"
          ? "agent_blocked"
          : undefined
        : "harness_mismatch",
    );
  }
  const processId = process?.pid ??
    processInfo.result.process_info.foreground_process_group_id;

  const home = requiredEnvironment(environment, "HOME") ?? "/home/agent";
  if (role === "crewmate") {
    if (agent.agent_session === undefined) {
      addCheck(evaluation, "session", "fail", "session_missing");
    } else {
      addCheck(evaluation, "session", "pass");
    }
    yield* verifyCrewmate(
      environment,
      probeRuntime,
      home,
      processId,
      harness,
      evaluation,
    );
    yield* verifyCodexGatewayProvider(
      environment,
      probeRuntime,
      home,
      evaluation,
    );
    yield* verifyDatabase(environment, probeRuntime, home, evaluation, false);
    yield* verifyCredential(role, environment, probeRuntime, home, evaluation);
  } else {
    const nativeSession = agent.agent_session;
    if (
      nativeSession === undefined ||
      nativeSession.kind !== "path" ||
      !nativeSession.value
    ) {
      addCheck(evaluation, "session", "fail", "session_missing");
    } else {
      const header = sessionHeader(
        yield* probeRuntime.readFirstLine(
          nativeSession.value,
          maximumSessionHeaderBytes,
        ),
      );
      if (header === undefined) {
        addCheck(evaluation, "session", "fail", "session_invalid");
      } else if (header.cwd !== expectedCwd) {
        addCheck(evaluation, "session", "fail", "session_cwd_mismatch");
      } else {
        addCheck(evaluation, "session", "pass");
      }
    }
    yield* verifyProvider(environment, probeRuntime, home, evaluation);
    yield* verifyCredential(role, environment, probeRuntime, home, evaluation);
    yield* verifyDatabase(environment, probeRuntime, home, evaluation, true);
    yield* verifyCoordination(
      environment,
      probeRuntime,
      home,
      processId,
      evaluation,
    );
  }

  return diagnostic(role, mode, evaluation);
});
