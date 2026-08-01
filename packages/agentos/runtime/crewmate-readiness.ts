import { createHash } from "node:crypto";
import { basename } from "node:path";

import { writeCrewmateReadiness } from "@akua-dev/agentos";
import { Effect, Option, Schema } from "effect";

const HerdrAgentSession = Schema.Struct({
  kind: Schema.String,
  value: Schema.String,
});
const HerdrAgent = Schema.Struct({
  agent_session: Schema.optionalKey(HerdrAgentSession),
  cwd: Schema.optionalKey(Schema.String),
  foreground_cwd: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  pane_id: Schema.optionalKey(Schema.String),
});
const HerdrAgentList = Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(HerdrAgent) }),
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

const ConfirmationReason = Schema.Literals([
  "agent_ambiguous",
  "agent_cwd_mismatch",
  "agent_missing",
  "agent_observation_invalid",
  "assignment_identity_invalid",
  "brief_digest_invalid",
  "brief_digest_mismatch",
  "brief_missing",
  "harness_mismatch",
  "harness_observation_invalid",
  "pane_process_unavailable",
  "runtime_configuration_invalid",
  "session_missing",
]);

type Environment = Readonly<Record<string, string | undefined>>;
type Reason = typeof ConfirmationReason.Type;

export type CrewmateConfirmationRuntime = {
  readonly readText: (
    path: string,
    maximumBytes: number,
  ) => Effect.Effect<string | undefined>;
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }>;
};

export class CrewmateConfirmationError extends Schema.TaggedErrorClass<CrewmateConfirmationError>()(
  "CrewmateConfirmationError",
  {
    message: Schema.String,
    reason: ConfirmationReason,
  },
) {}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const harnessPattern = /^[A-Za-z0-9._-]+$/;
const maximumBriefBytes = 1024 * 1024;

export const confirmCrewmateReadiness = Effect.fn(
  "agentos.crewmateReadiness.confirm",
)(function*(
  environment: Environment,
  runtime: CrewmateConfirmationRuntime,
  stateDirectory: string,
) {
  if (required(environment, "AGENTOS_AGENT_ROLE") !== "crewmate") {
    return yield* fail("runtime_configuration_invalid");
  }
  const agentName = required(environment, "AGENTOS_AGENT_NAME");
  const expectedCwd = required(environment, "AGENTOS_AGENT_CWD");
  const herdrSession = required(environment, "HERDR_SESSION");
  const harness = required(environment, "AGENTOS_HARNESS");
  if (
    agentName === undefined ||
    expectedCwd === undefined ||
    herdrSession === undefined ||
    harness === undefined ||
    !harnessPattern.test(harness)
  ) {
    return yield* fail("runtime_configuration_invalid");
  }

  const agentId = required(environment, "AGENTOS_AGENT_ID");
  const assignmentId = required(environment, "AGENTOS_ASSIGNMENT_ID");
  const taskId = required(environment, "AGENTOS_TASK_ID");
  if (
    agentId === undefined ||
    assignmentId === undefined ||
    taskId === undefined ||
    ![agentId, assignmentId, taskId].every((value) =>
      uuidPattern.test(value),
    )
  ) {
    return yield* fail("assignment_identity_invalid");
  }

  const briefPath = required(environment, "AGENTOS_BRIEF_PATH");
  const expectedBriefDigest = required(
    environment,
    "AGENTOS_BRIEF_SHA256",
  );
  if (
    expectedBriefDigest === undefined ||
    !digestPattern.test(expectedBriefDigest)
  ) {
    return yield* fail("brief_digest_invalid");
  }
  if (briefPath === undefined) return yield* fail("brief_missing");
  const brief = yield* runtime.readText(briefPath, maximumBriefBytes);
  if (brief === undefined || brief.length === 0) {
    return yield* fail("brief_missing");
  }
  const observedBriefDigest = createHash("sha256")
    .update(brief)
    .digest("hex");
  if (observedBriefDigest !== expectedBriefDigest) {
    return yield* fail("brief_digest_mismatch");
  }

  const listResult = yield* runtime.run([
    "herdr",
    "agent",
    "list",
    "--session",
    herdrSession,
  ]);
  const list = decode(
    HerdrAgentList,
    listResult.exitCode === 0 ? listResult.stdout : undefined,
  );
  if (list === undefined) return yield* fail("agent_observation_invalid");
  const matches = list.result.agents.filter(({ name }) => name === agentName);
  if (matches.length === 0) return yield* fail("agent_missing");
  if (matches.length !== 1) return yield* fail("agent_ambiguous");
  const agent = matches[0];
  if (agent === undefined) return yield* fail("agent_missing");
  if ((agent.foreground_cwd ?? agent.cwd) !== expectedCwd) {
    return yield* fail("agent_cwd_mismatch");
  }
  if (
    agent.agent_session === undefined ||
    !agent.agent_session.kind.trim() ||
    !agent.agent_session.value.trim()
  ) {
    return yield* fail("session_missing");
  }
  if (agent.pane_id === undefined) {
    return yield* fail("pane_process_unavailable");
  }

  const [explanationResult, processResult] = yield* Effect.all([
    runtime.run([
      "herdr",
      "agent",
      "explain",
      agentName,
      "--json",
      "--session",
      herdrSession,
    ]),
    runtime.run([
      "herdr",
      "pane",
      "process-info",
      "--pane",
      agent.pane_id,
      "--session",
      herdrSession,
    ]),
  ]);
  const explanation = decode(
    HerdrExplanation,
    explanationResult.exitCode === 0 ? explanationResult.stdout : undefined,
  );
  if (explanation === undefined) {
    return yield* fail("harness_observation_invalid");
  }
  const processInfo = decode(
    HerdrProcessInfo,
    processResult.exitCode === 0 ? processResult.stdout : undefined,
  );
  if (processInfo === undefined) {
    return yield* fail("pane_process_unavailable");
  }
  const process = processInfo.result.process_info.foreground_processes.find(
    ({ argv0 }) => basename(argv0) === harness,
  );
  if (
    explanation.agent !== harness ||
    process === undefined ||
    process.cwd !== expectedCwd ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0
  ) {
    return yield* fail("harness_mismatch");
  }

  return yield* writeCrewmateReadiness({
    agentId,
    assignmentId,
    briefSha256: observedBriefDigest,
    harness,
    herdrSession,
    processId: process.pid,
    stateDirectory,
    taskId,
  });
});

function required(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string | undefined,
): S["Type"] | undefined {
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(parsed));
}

function fail(reason: Reason) {
  return Effect.fail(
    CrewmateConfirmationError.make({ message: reason, reason }),
  );
}
