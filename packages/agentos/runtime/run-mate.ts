#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Config,
  Effect,
  Exit,
  Fiber,
  Option,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { resolvePersistentMateDistribution } from "./distribution.ts";
import {
  findPreparedPiSessionRelocation,
  preparePiSessionRelocation,
  readPiSession,
  type PiSessionEnvironment,
} from "./pi-session.ts";

const Agent = Schema.Struct({
  agent_session: Schema.optional(Schema.Struct({
    kind: Schema.optional(Schema.Unknown),
    value: Schema.optional(Schema.Unknown),
  })),
  cwd: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
  pane_id: Schema.optional(Schema.Unknown),
});
type Agent = typeof Agent.Type;
const AgentListJson = Schema.fromJsonString(Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(Agent) }),
}));

export class MateRuntimeError extends Schema.TaggedErrorClass<MateRuntimeError>()(
  "MateRuntimeError",
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const runtimeError = (message: string, cause?: unknown) =>
  MateRuntimeError.make({ cause, message });

const RuntimeConfig = Config.all({
  agentCwd: Config.string("AGENTOS_AGENT_CWD"),
  agentName: Config.string("AGENTOS_AGENT_NAME"),
  agentRole: Config.string("AGENTOS_AGENT_ROLE"),
  distributionRoot: Config.string("AGENTOS_DISTRIBUTION_ROOT"),
  fakeHerdrAgentKind: Config.option(Config.string("FAKE_HERDR_AGENT_KIND")),
  fakeHerdrAgentStatus: Config.option(Config.string("FAKE_HERDR_AGENT_STATUS")),
  fakeHerdrFailStart: Config.option(Config.string("FAKE_HERDR_FAIL_START")),
  fakeHerdrState: Config.option(Config.string("FAKE_HERDR_STATE")),
  fakePiExtension: Config.option(Config.string("FAKE_PI_EXTENSION")),
  fakePiSession: Config.option(Config.string("FAKE_PI_SESSION")),
  herdrSession: Config.option(Config.string("HERDR_SESSION")),
  home: Config.option(Config.string("HOME")),
  path: Config.option(Config.string("PATH")),
  piAgentDirectory: Config.option(Config.string("PI_CODING_AGENT_DIR")),
  piSessionDirectory: Config.option(Config.string("PI_CODING_AGENT_SESSION_DIR")),
  releaseRoot: Config.option(Config.string("AGENTOS_RELEASE_ROOT")),
});

type RuntimeConfiguration = Config.Success<typeof RuntimeConfig>;

export const runMate = Effect.scoped(Effect.gen(function*() {
  const config = yield* RuntimeConfig;
  const paths = yield* Path.Path;
  const environment = runtimeEnvironment(config);
  const { roleDirectory: agentCwd } = yield* resolvePersistentMateDistribution(environment);
  const session = Option.getOrUndefined(config.herdrSession) ?? `agentos-${config.agentName}`;
  const releaseRoot = Option.getOrUndefined(config.releaseRoot) ?? "/opt/agentos";
  const childEnvironment = {
    ...environment,
    NODE_PATH: paths.join(releaseRoot, "node_modules"),
  };

  const server = yield* ChildProcess.make("herdr", ["server", "--session", session], {
    env: childEnvironment,
    extendEnv: false,
    stderr: "inherit",
    stdout: "inherit",
  }).pipe(Effect.mapError((cause) => runtimeError("Could not start the Herdr server.", cause)));
  const serverExit = yield* server.exitCode.pipe(
    Effect.map(Number),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* waitUntilServerReady(serverExit, session, childEnvironment);

  const agents = yield* listAgents(session, childEnvironment);
  const mates = agents.filter(({ name }) => name === config.agentName);
  if (mates.length === 0) {
    yield* startMate(
      config.agentName,
      agentCwd,
      session,
      childEnvironment,
      yield* findPreparedPiSessionRelocation(agentCwd, environment),
    );
  } else if (mates.length === 1) {
    const mate = mates[0];
    if (mate === undefined) return yield* runtimeError("Herdr returned an empty Mate record.");
    if (yield* mateRunsFromCheckout(mate, agentCwd)) {
      yield* restoreMate(mate, config.agentName, agentCwd, session, childEnvironment);
    } else {
      yield* relocateMate(mate, config.agentName, agentCwd, session, environment, childEnvironment);
    }
  } else {
    return yield* runtimeError(
      `Refusing to start: expected at most one Herdr agent named ${config.agentName}, found ${mates.length}.`,
    );
  }

  const exitCode = yield* Fiber.join(serverExit).pipe(
    Effect.mapError((cause) => runtimeError("Herdr server failed.", cause)),
  );
  if (exitCode !== 0) {
    return yield* runtimeError(`Herdr server exited with status ${exitCode}.`);
  }
}));

function runtimeEnvironment(config: RuntimeConfiguration): PiSessionEnvironment {
  return {
    AGENTOS_AGENT_CWD: config.agentCwd,
    AGENTOS_AGENT_NAME: config.agentName,
    AGENTOS_AGENT_ROLE: config.agentRole,
    AGENTOS_DISTRIBUTION_ROOT: config.distributionRoot,
    AGENTOS_RELEASE_ROOT: Option.getOrUndefined(config.releaseRoot),
    FAKE_HERDR_AGENT_KIND: Option.getOrUndefined(config.fakeHerdrAgentKind),
    FAKE_HERDR_AGENT_STATUS: Option.getOrUndefined(config.fakeHerdrAgentStatus),
    FAKE_HERDR_FAIL_START: Option.getOrUndefined(config.fakeHerdrFailStart),
    FAKE_HERDR_STATE: Option.getOrUndefined(config.fakeHerdrState),
    FAKE_PI_EXTENSION: Option.getOrUndefined(config.fakePiExtension),
    FAKE_PI_SESSION: Option.getOrUndefined(config.fakePiSession),
    HERDR_SESSION: Option.getOrUndefined(config.herdrSession),
    HOME: Option.getOrUndefined(config.home),
    PATH: Option.getOrUndefined(config.path),
    PI_CODING_AGENT_DIR: Option.getOrUndefined(config.piAgentDirectory),
    PI_CODING_AGENT_SESSION_DIR: Option.getOrUndefined(config.piSessionDirectory),
  };
}

const mateRunsFromCheckout = Effect.fn("agentos.mate.runsFromCheckout")(
  function*(mate: Agent, agentCwd: string) {
    if (mate.cwd !== agentCwd) return false;
    const persistedSession = mate.agent_session?.value;
    if (mate.agent_session?.kind !== "path" || typeof persistedSession !== "string") return false;
    const { header } = yield* readPiSession(persistedSession);
    return header.cwd === agentCwd;
  },
);

const startMate = Effect.fn("agentos.mate.start")(function*(
  agentName: string,
  agentCwd: string,
  session: string,
  environment: PiSessionEnvironment,
  persistedSession?: string,
) {
  yield* runCommand([
    "herdr", "agent", "start", agentName, "--cwd", agentCwd, "--no-focus",
    "--session", session, "--", "pi", "--no-context-files",
    ...(persistedSession ? ["--session", persistedSession] : ["--continue"]),
  ], environment, { inherit: true, requireSuccess: true });
});

const relocateMate = Effect.fn("agentos.mate.relocate")(function*(
  mate: Agent,
  agentName: string,
  agentCwd: string,
  session: string,
  piEnvironment: PiSessionEnvironment,
  childEnvironment: PiSessionEnvironment,
) {
  const paneId = mate.pane_id;
  const persistedSession = mate.agent_session?.value;
  if (typeof paneId !== "string" || mate.agent_session?.kind !== "path" || typeof persistedSession !== "string") {
    return yield* runtimeError(
      `Refusing to move ${agentName} from ${String(mate.cwd)} without a persisted Pi session path.`,
    );
  }
  const relocatedSession = yield* preparePiSessionRelocation(persistedSession, agentCwd, piEnvironment);
  yield* runCommand(["herdr", "pane", "close", paneId, "--session", session], childEnvironment, { requireSuccess: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((yield* commandStatus(["herdr", "agent", "get", agentName, "--session", session], childEnvironment)) !== 0) {
      yield* startMate(agentName, agentCwd, session, childEnvironment, relocatedSession);
      return;
    }
    yield* Effect.sleep("100 millis");
  }
  return yield* runtimeError(`Herdr did not release ${agentName} after closing pane ${paneId}.`);
});

const waitUntilServerReady = Effect.fn("agentos.mate.waitForServer")(function*(
  serverExit: Fiber.Fiber<number, unknown>,
  session: string,
  environment: PiSessionEnvironment,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const exit = yield* Fiber.join(serverExit).pipe(
      Effect.timeoutOption("1 millis"),
    );
    if (Option.isSome(exit)) {
      return yield* runtimeError(`Herdr server exited before session ${session} became ready.`);
    }
    if ((yield* commandStatus(["herdr", "status", "--json", "--session", session], environment)) === 0) return;
    yield* Effect.sleep("500 millis");
  }
  return yield* runtimeError(`Herdr session ${session} did not become ready within 30 seconds.`);
});

const listAgents = Effect.fn("agentos.mate.listAgents")(function*(
  session: string,
  environment: PiSessionEnvironment,
) {
  const result = yield* runCommand(["herdr", "agent", "list", "--session", session], environment, { requireSuccess: true });
  const decoded = yield* Schema.decodeUnknownEffect(AgentListJson)(result.stdout).pipe(
    Effect.mapError((cause) => runtimeError("Herdr returned an invalid agent list.", cause)),
  );
  return decoded.result.agents;
});

const restoreMate = Effect.fn("agentos.mate.restore")(function*(
  mate: Agent,
  agentName: string,
  agentCwd: string,
  session: string,
  environment: PiSessionEnvironment,
) {
  const paneId = mate.pane_id;
  if (typeof paneId !== "string") {
    return yield* runtimeError(`Refusing to restore ${agentName} without a Herdr pane ID.`);
  }
  const observer = yield* ChildProcess.make("herdr", [
    "terminal", "session", "observe", agentName, "--cols", "120", "--rows", "40", "--session", session,
  ], { env: { ...environment }, extendEnv: false, stderr: "ignore", stdout: "ignore" }).pipe(
    Effect.mapError((cause) => runtimeError("Could not start the Herdr observer.", cause)),
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((yield* commandStatus(["herdr", "pane", "process-info", "--pane", paneId, "--session", session], environment)) === 0) {
      yield* observer.kill({ killSignal: "SIGTERM", forceKillAfter: 2_000 }).pipe(Effect.ignore);
      return;
    }
    yield* Effect.sleep("100 millis");
  }
  yield* observer.kill({ killSignal: "SIGTERM", forceKillAfter: 2_000 }).pipe(Effect.ignore);
  yield* relocateMate(mate, agentName, agentCwd, session, environment, environment);
});

const commandStatus = (arguments_: ReadonlyArray<string>, environment: PiSessionEnvironment) =>
  runCommand(arguments_, environment, {}).pipe(Effect.map(({ exitCode }) => exitCode));

const runCommand = Effect.fn("agentos.mate.command")(function*(
  arguments_: ReadonlyArray<string>,
  environment: PiSessionEnvironment,
  options: { readonly inherit?: boolean; readonly requireSuccess?: boolean },
) {
  const [command, ...args] = arguments_;
  if (command === undefined) return yield* runtimeError("Cannot run an empty command.");
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, args, {
      env: { ...environment },
      extendEnv: false,
      stderr: options.inherit ? "inherit" : "pipe",
      stdout: options.inherit ? "inherit" : "pipe",
    }).pipe(Effect.mapError((cause) => runtimeError(`Could not start ${command}.`, cause)));
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      options.inherit ? Effect.succeed("") : child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      options.inherit ? Effect.succeed("") : child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError((cause) => runtimeError(`Could not collect ${command} output.`, cause)),
    );
    if (options.requireSuccess && exitCode !== 0) {
      return yield* runtimeError(`${arguments_.join(" ")} failed with status ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`);
    }
    return { exitCode, stderr, stdout };
  }));
});

const reportFailure = (error: unknown) => Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const message = error instanceof Error ? error.message : String(error);
  yield* Stream.make(`${message}\n`).pipe(Stream.run(stdio.stderr()), Effect.ignore);
});

if (import.meta.main) {
  BunRuntime.runMain(
    runMate.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(BunServices.layer),
    ),
    {
      disableErrorReporting: true,
      teardown: (exit, onExit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? onExit(0)
          : Runtime.defaultTeardown(exit, onExit),
    },
  );
}
