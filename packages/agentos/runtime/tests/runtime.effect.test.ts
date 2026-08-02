import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

const repositoryUrl = new URL("../../../..", import.meta.url);
const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const Agent = Schema.Struct({
  agent_session: Schema.optional(Schema.Struct({
    kind: Schema.String,
    value: Schema.String,
  })),
  agent_status: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  foreground_cwd: Schema.optional(Schema.String),
  live: Schema.optional(Schema.Boolean),
  name: Schema.String,
  pane_id: Schema.optional(Schema.String),
});
type Agent = typeof Agent.Type;
const Agents = Schema.Array(Agent);
const Call = Schema.Array(Schema.String);
const Calls = Schema.Array(Call);
const CallFromJson = Schema.fromJsonString(Call);
const SessionHeader = Schema.Struct({
  cwd: Schema.String,
  id: Schema.String,
  parentSession: Schema.optional(Schema.String),
  type: Schema.Literal("session"),
  version: Schema.Number,
});
const SessionMessage = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  parentId: Schema.String,
  type: Schema.Literal("message"),
});
const PiSettings = Schema.Struct({ sessionDir: Schema.String });
const ProviderReadiness = Schema.Struct({
  files: Schema.Struct({
    markerSha256: Schema.NullOr(Schema.String),
    modelsSha256: Schema.NullOr(Schema.String),
    settingsSha256: Schema.NullOr(Schema.String),
  }),
  mode: Schema.Literal("direct"),
  selectedModel: Schema.Null,
  selectedThinking: Schema.Null,
  version: Schema.Literal(1),
});
const CoordinationReadiness = Schema.Struct({
  agentName: Schema.String,
  herdrSession: Schema.String,
  listenerProcessId: Schema.Number,
  listenerTaskId: Schema.String,
  ownerProcessId: Schema.Number,
  phase: Schema.Literal("caught_up"),
  version: Schema.Literal(1),
});
const HealthResponse = Schema.Struct({
  checks: Schema.Array(Schema.Struct({
    component: Schema.String,
    status: Schema.String,
  })),
  mode: Schema.Literals(["live", "ready"]),
  reasons: Schema.Array(Schema.String),
  role: Schema.String,
  status: Schema.String,
  version: Schema.Literal(1),
});
const DependencyPackage = Schema.Struct({
  main: Schema.String,
  name: Schema.String,
});

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type RuntimePaths = {
  readonly defaultDistributionRoot: string;
  readonly defaultFirstMateCwd: string;
  readonly fakeHerdrFixture: string;
  readonly health: string;
  readonly repository: string;
  readonly runMate: string;
};
type Harness = {
  readonly environment: RuntimeEnvironment;
  readonly paths: RuntimePaths;
  readonly piSession: string;
  readonly state: string;
};
type RunningRuntime = {
  readonly child: ChildProcessHandle;
  readonly exit: Fiber.Fiber<number, RuntimeTestError>;
};

class RuntimeTestError extends Schema.TaggedErrorClass<RuntimeTestError>()(
  "RuntimeTestError",
  {
    detail: Schema.optional(Schema.String),
    operation: Schema.String,
  },
) {}

class ActivityPending extends Schema.TaggedErrorClass<ActivityPending>()(
  "ActivityPending",
  { operation: Schema.String },
) {}

const testError = (operation: string, detail?: string) =>
  RuntimeTestError.make({ detail, operation });

const runtimePaths = Effect.fn("test.mateRuntime.paths")(function*() {
  const paths = yield* Path.Path;
  const repository = paths.resolve(yield* paths.fromFileUrl(repositoryUrl));
  const runtime = paths.join(repository, "packages", "agentos", "runtime");
  const defaultDistributionRoot = paths.join(repository, "packages", "agentos");
  return {
    defaultDistributionRoot,
    defaultFirstMateCwd: paths.join(
      defaultDistributionRoot,
      "resources",
      "roles",
      "firstmate",
    ),
    fakeHerdrFixture: paths.join(
      runtime,
      "tests",
      "fixtures",
      "fake-herdr.effect.ts",
    ),
    health: paths.join(runtime, "health.ts"),
    repository,
    runMate: paths.join(runtime, "run-mate.ts"),
  } satisfies RuntimePaths;
});

function encodeJson<S extends Schema.Constraint>(schema: S, value: S["Type"]) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value);
}

function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source);
}

const writeJson = Effect.fn("test.mateRuntime.writeJson")(function*<
  S extends Schema.Constraint,
>(
  path: string,
  schema: S,
  value: S["Type"],
  mode?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* encodeJson(schema, value);
  yield* fileSystem.writeFileString(path, `${source}\n`, { mode });
});

function shellSingleQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const makeExecutable = Effect.fn("test.mateRuntime.makeExecutable")(function*(
  path: string,
  source: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(path, source);
  yield* fileSystem.chmod(path, 0o755);
});

const createHarness = Effect.fn("test.mateRuntime.createHarness")(function*(
  agents: ReadonlyArray<Agent>,
  overrides: RuntimeEnvironment = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const executablePath = yield* Config.string("PATH");
  const resolved = yield* runtimePaths();
  const sandbox = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-firstmate-runtime-",
  });
  const fakeBin = paths.join(sandbox, "bin");
  const state = paths.join(sandbox, "state");
  const piAgentDirectory = paths.join(state, "pi-agent");
  const piSession = paths.join(state, "pi-session.jsonl");
  const providerState = paths.join(
    state,
    "home",
    ".local",
    "state",
    "agentos",
  );
  const readinessState = paths.join(providerState, "readiness");
  yield* Effect.forEach([
    fakeBin,
    state,
    piAgentDirectory,
    providerState,
    readinessState,
  ], (directory) => fileSystem.makeDirectory(directory, { recursive: true }), {
    concurrency: "unbounded",
    discard: true,
  });

  const agentCwd = overrides.AGENTOS_AGENT_CWD ??
    resolved.defaultFirstMateCwd;
  const agentName = overrides.AGENTOS_AGENT_NAME ?? "firstmate";
  const herdrSession = overrides.HERDR_SESSION ?? "agentos-firstmate-test";
  yield* Effect.all([
    writeJson(piSession, SessionHeader, {
      cwd: agentCwd,
      id: "runtime-test",
      type: "session",
      version: 3,
    }, 0o600),
    fileSystem.writeFileString(
      paths.join(piAgentDirectory, "auth.json"),
      "not-read-by-readiness",
      { mode: 0o600 },
    ),
    fileSystem.writeFileString(
      paths.join(state, "home", ".pgpass"),
      "not-read-by-readiness",
      { mode: 0o600 },
    ),
    writeJson(
      paths.join(providerState, "pi-provider-readiness.json"),
      ProviderReadiness,
      {
        files: {
          markerSha256: null,
          modelsSha256: null,
          settingsSha256: null,
        },
        mode: "direct",
        selectedModel: null,
        selectedThinking: null,
        version: 1,
      },
      0o600,
    ),
    writeJson(
      paths.join(readinessState, "coordination.json"),
      CoordinationReadiness,
      {
        agentName,
        herdrSession,
        listenerProcessId: 1,
        listenerTaskId: "bg-listener",
        ownerProcessId: 4242,
        phase: "caught_up",
        version: 1,
      },
      0o600,
    ),
    writeJson(paths.join(state, "agents.json"), Agents, agents),
  ], { concurrency: "unbounded", discard: true });

  yield* makeExecutable(
    paths.join(fakeBin, "herdr"),
    [
      "#!/bin/sh",
      "FAKE_HERDR_ARGUMENTS=\"$(printf '%s\\037' \"$@\")\"",
      "FAKE_HERDR_PARENT_PID=\"$PPID\"",
      "export FAKE_HERDR_ARGUMENTS",
      "export FAKE_HERDR_PARENT_PID",
      "exec bun " + shellSingleQuote(resolved.fakeHerdrFixture),
      "",
    ].join("\n"),
  );

  const secondMate = overrides.AGENTOS_AGENT_ROLE === "second_mate";
  const environment: RuntimeEnvironment = {
    AGENTOS_AGENT_CWD: resolved.defaultFirstMateCwd,
    AGENTOS_AGENT_NAME: "firstmate",
    AGENTOS_AGENT_ROLE: "first_mate",
    AGENTOS_DATABASE_IDENTITY: secondMate
      ? "runtime_secondmate"
      : "runtime_firstmate",
    AGENTOS_DATABASE_URL: secondMate
      ? "postgresql://runtime_secondmate@postgres:5432/agentos?sslmode=require"
      : "postgresql://runtime_firstmate@postgres:5432/agentos?sslmode=require",
    AGENTOS_DISTRIBUTION_ROOT: resolved.defaultDistributionRoot,
    AGENTOS_RELEASE_ROOT: resolved.repository,
    FAKE_HERDR_STATE: state,
    FAKE_PI_SESSION: piSession,
    HERDR_SESSION: "agentos-firstmate-test",
    HOME: paths.join(state, "home"),
    PATH: `${fakeBin}:${executablePath}`,
    PGPASSFILE: paths.join(state, "home", ".pgpass"),
    PI_CODING_AGENT_DIR: piAgentDirectory,
    ...overrides,
  };
  return { environment, paths: resolved, piSession, state } satisfies Harness;
});

const readCalls = Effect.fn("test.mateRuntime.readCalls")(function*(state: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const path = paths.join(state, "calls.jsonl");
  if (!(yield* fileSystem.exists(path))) return [];
  const source = (yield* fileSystem.readFileString(path)).trim();
  if (source === "") return [];
  return yield* Effect.forEach(
    source.split("\n"),
    (line) => Schema.decodeUnknownEffect(CallFromJson)(line),
  );
});

const collectChild = Effect.fn("test.mateRuntime.collectChild")(function*(
  child: ChildProcessHandle,
) {
  const [exitCode, stderr, stdout] = yield* Effect.all([
    child.exitCode.pipe(Effect.map(Number)),
    child.stderr.pipe(Stream.decodeText(), Stream.mkString),
    child.stdout.pipe(Stream.decodeText(), Stream.mkString),
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError(() => testError("child_collect")),
  );
  return { exitCode, stderr, stdout };
});

const collectRuntimeChild = Effect.fn(
  "test.mateRuntime.collectRuntimeChild",
)(function*(runtime: RunningRuntime) {
  const exitCode = yield* Fiber.join(runtime.exit);
  return { exitCode, stderr: "", stdout: "" };
});

const startRuntime = Effect.fn("test.mateRuntime.start")(function*(
  harness: Harness,
  environment: RuntimeEnvironment = harness.environment,
) {
  const child = yield* ChildProcess.make("bun", [harness.paths.runMate], {
    env: environment,
    extendEnv: false,
    stderr: "ignore",
    stdout: "ignore",
  }).pipe(Effect.mapError(() => testError("runtime_spawn")));
  const exit = yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError(() => testError("runtime_collect")),
    Effect.forkScoped({ startImmediately: true }),
  );
  return { child, exit } satisfies RunningRuntime;
});

const stopRuntime = Effect.fn("test.mateRuntime.stop")(function*(
  runtime: RunningRuntime,
) {
  yield* runtime.child.kill({
    forceKillAfter: 2_000,
    killSignal: "SIGTERM",
  }).pipe(Effect.mapError(() => testError("runtime_stop")));
  return yield* collectRuntimeChild(runtime);
});

const runProcess = Effect.fn("test.mateRuntime.runProcess")(function*(
  executable: string,
  arguments_: ReadonlyArray<string>,
  environment: RuntimeEnvironment,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(arguments_), {
      env: environment,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(Effect.mapError(() => testError("process_spawn")));
    return yield* collectChild(child);
  }));
});

function waitFor<R, E>(
  operation: string,
  predicate: Effect.Effect<boolean, E, R>,
  attempts = 150,
) {
  return TestClock.withLive(predicate.pipe(
    Effect.flatMap((ready) =>
      ready
        ? Effect.void
        : Effect.fail(ActivityPending.make({ operation }))
    ),
    Effect.retry({
      schedule: Schedule.spaced("20 millis"),
      times: attempts,
      while: isActivityPending,
    }),
    Effect.mapError((error) =>
      isActivityPending(error)
        ? testError(operation, "timed_out")
        : error
    ),
  ));
}

function isActivityPending(error: unknown): error is ActivityPending {
  return error instanceof ActivityPending;
}

const childFailureDiagnostics = Effect.fn(
  "test.mateRuntime.childFailureDiagnostics",
)(function*(
  runtime: RunningRuntime,
  state: string,
  outcome: "exited" | "timed_out",
) {
  if (outcome === "timed_out") {
    yield* runtime.child.kill({
      forceKillAfter: 2_000,
      killSignal: "SIGTERM",
    }).pipe(Effect.ignore);
  }
  const result = yield* collectRuntimeChild(runtime);
  const calls = yield* readCalls(state);
  const encodedCalls = yield* encodeJson(Calls, calls);
  return [
    `Mate runtime ${outcome} before expected fake Herdr activity (exit ${result.exitCode}).`,
    `Calls: ${encodedCalls}`,
    `stdout: ${result.stdout.trim() || "<empty>"}`,
    `stderr: ${result.stderr.trim() || "<empty>"}`,
  ].join("\n");
});

function waitForChildActivity<R, E>(
  runtime: RunningRuntime,
  state: string,
  predicate: Effect.Effect<boolean, E, R>,
  attempts: number,
) {
  const operation = "runtime_activity";
  return TestClock.withLive(Effect.gen(function*() {
    const ready = yield* predicate;
    if (ready) return;
    if (!(yield* runtime.child.isRunning)) {
      return yield* testError(
        operation,
        yield* childFailureDiagnostics(runtime, state, "exited"),
      );
    }
    return yield* ActivityPending.make({ operation });
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("20 millis"),
      times: attempts,
      while: isActivityPending,
    }),
    Effect.catchIf(
      isActivityPending,
      () =>
        childFailureDiagnostics(runtime, state, "timed_out").pipe(
          Effect.flatMap((detail) => Effect.fail(testError(operation, detail))),
        ),
    ),
  ));
}

function callsMatch(
  calls: ReadonlyArray<ReadonlyArray<string>>,
  expected: ReadonlyArray<string>,
) {
  return calls.some((call) =>
    call.length === expected.length &&
    call.every((argument, index) => argument === expected[index])
  );
}

function startCalls(calls: ReadonlyArray<ReadonlyArray<string>>) {
  return calls.filter((call) =>
    call[0] === "agent" && call[1] === "start"
  );
}

function withoutEnvironment(
  environment: RuntimeEnvironment,
  names: ReadonlyArray<string>,
) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.includes(name)),
  );
}

function requireValue<A>(value: A | undefined, operation: string) {
  return value === undefined
    ? Effect.fail(testError(operation))
    : Effect.succeed(value);
}

const readSessionLine = Effect.fn("test.mateRuntime.readSessionLine")(
  function*<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    index: number,
    schema: S,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const line = (yield* fileSystem.readFileString(path)).trim().split("\n")[index];
    return yield* decodeJson(schema, yield* requireValue(line, "session_line"));
  },
);

const findSessionHeader = Effect.fn("test.mateRuntime.findSessionHeader")(
  function*(source: string) {
    for (const line of source.split("\n")) {
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(SessionHeader),
      )(line);
      if (Option.isSome(decoded)) return decoded.value;
    }
    return yield* testError("session_header");
  },
);

const runHealth = Effect.fn("test.mateRuntime.runHealth")(function*(
  harness: Harness,
  mode: "live" | "ready",
) {
  return yield* runProcess(
    "bun",
    [harness.paths.health, mode],
    harness.environment,
  );
});

layer(platform)("Mate runtime", (it) => {
  it.effect(
    "starts one named Pi agent on an empty Herdr session",
    () => Effect.scoped(Effect.gen(function*() {
      const harness = yield* createHarness([]);
      const child = yield* startRuntime(harness);
      const expectedStart = [
        "agent",
        "start",
        "firstmate",
        "--cwd",
        harness.paths.defaultFirstMateCwd,
        "--no-focus",
        "--session",
        "agentos-firstmate-test",
        "--",
        "pi",
        "--no-context-files",
        "--continue",
      ];
      yield* waitFor(
        "firstmate_start",
        readCalls(harness.state).pipe(
          Effect.map((calls) => callsMatch(calls, expectedStart)),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      assert.deepStrictEqual(
        startCalls(yield* readCalls(harness.state)),
        [expectedStart],
      );
    })),
    20_000,
  );

  it.effect(
    "delegates sole-session recovery to Pi when Herdr has no agent",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      const sessions = paths.join(
        piAgentDirectory,
        "sessions",
        `--${agentCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      );
      yield* fileSystem.makeDirectory(sessions, { recursive: true });
      yield* writeJson(paths.join(sessions, "session.jsonl"), SessionHeader, {
        cwd: agentCwd,
        id: "session-retained",
        type: "session",
        version: 3,
      });
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "native_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.at(-1) === "--continue")
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "delegates configured session directory recovery to Pi",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const home = paths.join(harness.state, "home");
      const sessionDirectory = paths.join(home, "retained-sessions");
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      yield* Effect.all([
        fileSystem.makeDirectory(sessionDirectory, { recursive: true }),
        fileSystem.makeDirectory(piAgentDirectory, { recursive: true }),
      ], { concurrency: "unbounded", discard: true });
      yield* Effect.all([
        writeJson(
          paths.join(piAgentDirectory, "settings.json"),
          PiSettings,
          { sessionDir: "~/retained-sessions" },
        ),
        writeJson(
          paths.join(sessionDirectory, "session.jsonl"),
          SessionHeader,
          {
            cwd: agentCwd,
            id: "session-configured",
            type: "session",
            version: 3,
          },
        ),
      ], { concurrency: "unbounded", discard: true });
      const child = yield* startRuntime(harness, {
        ...harness.environment,
        HOME: home,
        PI_CODING_AGENT_SESSION_DIR: "",
      });
      yield* waitFor(
        "configured_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.at(-1) === "--continue")
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "delegates relative session directory recovery from the target Mate cwd to Pi",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const base = yield* runtimePaths();
      const distributionRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-relative-distribution-",
      });
      const agentCwd = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: agentCwd,
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
      });
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const sessionDirectory = paths.join(agentCwd, ".pi", "retained-sessions");
      yield* Effect.all([
        fileSystem.makeDirectory(sessionDirectory, { recursive: true }),
        fileSystem.makeDirectory(piAgentDirectory, { recursive: true }),
      ], { concurrency: "unbounded", discard: true });
      yield* Effect.all([
        writeJson(
          paths.join(piAgentDirectory, "settings.json"),
          PiSettings,
          { sessionDir: ".pi/retained-sessions" },
        ),
        writeJson(
          paths.join(sessionDirectory, "session.jsonl"),
          SessionHeader,
          {
            cwd: agentCwd,
            id: "session-relative",
            type: "session",
            version: 3,
          },
        ),
      ], { concurrency: "unbounded", discard: true });
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "relative_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) =>
              call.includes(agentCwd) && call.at(-1) === "--continue"
            )
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      assert.strictEqual(base.repository, harness.paths.repository);
    })),
    20_000,
  );

  it.effect(
    "delegates malformed session preambles to Pi",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      const sessions = paths.join(
        piAgentDirectory,
        "sessions",
        "--legacy-cwd--",
      );
      yield* fileSystem.makeDirectory(sessions, { recursive: true });
      const header = yield* encodeJson(SessionHeader, {
        cwd: agentCwd,
        id: "session-with-preamble",
        type: "session",
        version: 3,
      });
      yield* fileSystem.writeFileString(
        paths.join(sessions, "session.jsonl"),
        ["", "{malformed", "null", "false", header, "preserve me", ""].join("\n"),
      );
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "malformed_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.at(-1) === "--continue")
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "delegates bounded session discovery to Pi",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const sessionDirectory = paths.join(harness.state, "oversized-sessions");
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      yield* fileSystem.makeDirectory(sessionDirectory, { recursive: true });
      const header = yield* encodeJson(SessionHeader, {
        cwd: agentCwd,
        id: "session-beyond-scan-limit",
        type: "session",
        version: 3,
      });
      yield* fileSystem.writeFileString(
        paths.join(sessionDirectory, "oversized.jsonl"),
        `${"{malformed\n".repeat(100_000)}${header}\n`,
      );
      const child = yield* startRuntime(harness, {
        ...harness.environment,
        PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      });
      yield* waitFor(
        "bounded_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.at(-1) === "--continue")
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "delegates multiple retained sessions to Pi native recent recovery",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      const sessions = paths.join(
        piAgentDirectory,
        "sessions",
        `--${agentCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      );
      yield* fileSystem.makeDirectory(sessions, { recursive: true });
      yield* Effect.forEach(
        ["session-one.jsonl", "session-two.jsonl"],
        (name, index) =>
          writeJson(paths.join(sessions, name), SessionHeader, {
            cwd: agentCwd,
            id: `session-${index}`,
            type: "session",
            version: 3,
          }),
        { concurrency: "unbounded", discard: true },
      );
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "multiple_continue",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.at(-1) === "--continue")
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "gives a persistent checkout access to release-installed dependencies",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const releaseRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-release-",
      });
      const persistentCheckout = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-checkout-",
      });
      const distributionRoot = paths.join(
        persistentCheckout,
        "packages",
        "agentos",
      );
      const agentCwd = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      yield* fileSystem.makeDirectory(agentCwd, { recursive: true });
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: agentCwd,
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        AGENTOS_RELEASE_ROOT: releaseRoot,
        NODE_PATH: "",
      });
      const child = yield* startRuntime(harness);
      yield* waitForChildActivity(
        child,
        harness.state,
        Effect.all([
          fileSystem.exists(paths.join(harness.state, "server-ready")),
          readCalls(harness.state).pipe(
            Effect.map((calls) => startCalls(calls).length > 0),
          ),
        ]).pipe(Effect.map(([ready, started]) => ready && started)),
        150,
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      assert.strictEqual(
        yield* fileSystem.readFileString(
          paths.join(harness.state, "server-node-path"),
        ),
        paths.join(releaseRoot, "node_modules"),
      );
      assert.isTrue(
        startCalls(yield* readCalls(harness.state)).some((call) =>
          call.includes(agentCwd)
        ),
      );
    })),
    20_000,
  );

  it.effect(
    "resolves a release dependency from a persistent Pi extension child",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const releaseRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-release-",
      });
      const dependencyRoot = paths.join(
        releaseRoot,
        "node_modules",
        "release-only-dependency",
      );
      yield* fileSystem.makeDirectory(dependencyRoot, { recursive: true });
      yield* Effect.all([
        writeJson(
          paths.join(dependencyRoot, "package.json"),
          DependencyPackage,
          {
            main: "index.cjs",
            name: "release-only-dependency",
          },
        ),
        fileSystem.writeFileString(
          paths.join(dependencyRoot, "index.cjs"),
          "module.exports = { value: 'loaded from release image' };\n",
        ),
      ], { concurrency: "unbounded", discard: true });
      const persistentCheckout = paths.join(
        releaseRoot,
        "persistent-checkout",
      );
      const distributionRoot = paths.join(
        persistentCheckout,
        "packages",
        "agentos",
      );
      const agentCwd = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      const extensionDirectory = paths.join(
        agentCwd,
        ".pi",
        "extensions",
      );
      const extension = paths.join(
        extensionDirectory,
        "agentos-mate-memory.mjs",
      );
      yield* fileSystem.makeDirectory(extensionDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        extension,
        [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'const dependency = require("release-only-dependency");',
          "console.log(dependency.value);",
          "",
        ].join("\n"),
      );
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: agentCwd,
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        AGENTOS_RELEASE_ROOT: releaseRoot,
        FAKE_PI_EXTENSION: extension,
        NODE_PATH: "",
      });
      const child = yield* startRuntime(harness);
      const childResult = paths.join(harness.state, "child-result");
      yield* waitFor(
        "extension_result",
        fileSystem.exists(childResult),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      assert.strictEqual(
        yield* fileSystem.readFileString(childResult),
        "loaded from release image",
      );
    })),
    20_000,
  );

  it.effect(
    "triggers native restore instead of creating a second First Mate",
    () => Effect.scoped(Effect.gen(function*() {
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const persistedSession = paths.join(
        harness.state,
        "current-session.jsonl",
      );
      yield* writeJson(persistedSession, SessionHeader, {
        cwd: harness.paths.defaultFirstMateCwd,
        id: "session-current",
        type: "session",
        version: 3,
      });
      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: persistedSession },
          cwd: harness.paths.defaultFirstMateCwd,
          live: true,
          name: "firstmate",
          pane_id: "w1:p1",
        }],
      );
      const child = yield* startRuntime(harness);
      const expectedProcessInfo = [
        "pane",
        "process-info",
        "--pane",
        "w1:p1",
        "--session",
        "agentos-firstmate-test",
      ];
      yield* waitForChildActivity(
        child,
        harness.state,
        readCalls(harness.state).pipe(
          Effect.map((calls) => callsMatch(calls, expectedProcessInfo)),
        ),
        1_750,
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      const calls = yield* readCalls(harness.state);
      assert.deepStrictEqual(startCalls(calls), []);
      assert.deepStrictEqual(
        calls.filter((call) => call.slice(0, 2).join(" ") === "pane process-info"),
        [expectedProcessInfo],
      );
    })),
    45_000,
  );

  it.effect(
    "prepares a rollback-safe Pi session on the configured checkout",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const persistedSession = paths.join(harness.state, "session.jsonl");
      const previousCwd =
        "/opt/agentos/packages/agentos/resources/roles/firstmate";
      const header = yield* encodeJson(SessionHeader, {
        cwd: previousCwd,
        id: "session-1",
        type: "session",
        version: 3,
      });
      const message = yield* encodeJson(SessionMessage, {
        id: "message-1",
        message: "preserve me",
        parentId: "session-1",
        type: "message",
      });
      yield* fileSystem.writeFileString(
        persistedSession,
        [header, message, ""].join("\n"),
      );
      const paneId = "w1:p1";
      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: persistedSession },
          cwd: harness.environment.AGENTOS_AGENT_CWD,
          name: "firstmate",
          pane_id: paneId,
        }],
      );
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "relocated_start",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.includes("--session"))
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      const calls = yield* readCalls(harness.state);
      assert.deepStrictEqual(
        calls.filter((call) => call[0] === "pane" && call[1] === "close"),
        [["pane", "close", paneId, "--session", "agentos-firstmate-test"]],
      );
      const starts = startCalls(calls);
      assert.lengthOf(starts, 1);
      const relocatedSession = yield* requireValue(
        starts[0]?.at(-1),
        "relocated_session",
      );
      assert.notStrictEqual(relocatedSession, persistedSession);
      assert.deepStrictEqual(
        yield* readSessionLine(persistedSession, 0, SessionHeader),
        {
          cwd: previousCwd,
          id: "session-1",
          type: "session",
          version: 3,
        },
      );
      assert.deepInclude(
        yield* readSessionLine(relocatedSession, 0, SessionHeader),
        {
          cwd: harness.environment.AGENTOS_AGENT_CWD,
          id: "session-1",
          parentSession: persistedSession,
          type: "session",
          version: 3,
        },
      );
      assert.deepStrictEqual(
        yield* readSessionLine(relocatedSession, 1, SessionMessage),
        {
          id: "message-1",
          message: "preserve me",
          parentId: "session-1",
          type: "message",
        },
      );
    })),
    20_000,
  );

  it.effect(
    "resolves a relocated sessionDir from the target Mate cwd",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const distributionRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-relocation-distribution-",
      });
      const agentCwd = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      yield* fileSystem.makeDirectory(agentCwd, { recursive: true });
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: agentCwd,
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
        PI_CODING_AGENT_SESSION_DIR: "",
      });
      const persistedSession = paths.join(
        harness.state,
        "legacy-session.jsonl",
      );
      const previousCwd =
        "/opt/agentos/packages/agentos/resources/roles/firstmate";
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      yield* fileSystem.makeDirectory(piAgentDirectory, { recursive: true });
      yield* Effect.all([
        writeJson(persistedSession, SessionHeader, {
          cwd: previousCwd,
          id: "session-relative-relocation",
          type: "session",
          version: 3,
        }),
        writeJson(
          paths.join(piAgentDirectory, "settings.json"),
          PiSettings,
          { sessionDir: ".pi/relocated-sessions" },
        ),
      ], { concurrency: "unbounded", discard: true });
      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: persistedSession },
          cwd: previousCwd,
          name: "firstmate",
          pane_id: "w1:p1",
        }],
      );
      const child = yield* startRuntime(harness);
      yield* waitForChildActivity(
        child,
        harness.state,
        readCalls(harness.state).pipe(
          Effect.map((calls) => startCalls(calls).length > 0),
        ),
        150,
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      const start = yield* requireValue(
        startCalls(yield* readCalls(harness.state))[0],
        "relocated_start",
      );
      assert.strictEqual(
        paths.dirname(yield* requireValue(start.at(-1), "session_argument")),
        paths.join(agentCwd, ".pi", "relocated-sessions"),
      );
    })),
    20_000,
  );

  it.effect(
    "keeps a native recovery path when relocated Mate startup fails",
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const harness = yield* createHarness([], {
        FAKE_HERDR_FAIL_START: "1",
      });
      const paneId = "w1:p1";
      const previousCwd =
        "/opt/agentos/packages/agentos/resources/roles/firstmate";
      const sourceDirectory = paths.join(harness.state, "legacy-sessions");
      const persistedSession = paths.join(sourceDirectory, "session.jsonl");
      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      const header = yield* encodeJson(SessionHeader, {
        cwd: previousCwd,
        id: "session-relocation-rollback",
        type: "session",
        version: 3,
      });
      const sourceContents = [
        "",
        "{malformed",
        "null",
        "false",
        header,
        "preserve me",
        "",
      ].join("\n");
      yield* fileSystem.writeFileString(persistedSession, sourceContents);
      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: persistedSession },
          cwd: previousCwd,
          name: "firstmate",
          pane_id: paneId,
        }],
      );
      const failed = yield* runProcess(
        "bun",
        [harness.paths.runMate],
        harness.environment,
      );
      assert.strictEqual(failed.exitCode, 1);
      assert.strictEqual(
        yield* fileSystem.readFileString(persistedSession),
        sourceContents,
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      const piAgentDirectory = yield* requireValue(
        harness.environment.PI_CODING_AGENT_DIR,
        "pi_agent_directory",
      );
      const targetDirectory = paths.join(
        piAgentDirectory,
        "sessions",
        `--${agentCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      );
      const targetSessions = (yield* fileSystem.readDirectory(targetDirectory))
        .filter((name) => name.endsWith(".jsonl"));
      assert.lengthOf(targetSessions, 1);
      const targetName = yield* requireValue(
        targetSessions[0],
        "target_session",
      );
      const target = paths.join(targetDirectory, targetName);
      const targetContents = yield* fileSystem.readFileString(target);
      assert.isTrue(targetContents.startsWith("\n{malformed\nnull\nfalse\n"));
      assert.deepInclude(yield* findSessionHeader(targetContents), {
        cwd: agentCwd,
        parentSession: persistedSession,
        type: "session",
        version: 3,
      });

      const startsBeforeRetry = startCalls(
        yield* readCalls(harness.state),
      ).length;
      const recovered = yield* startRuntime(
        harness,
        withoutEnvironment(harness.environment, ["FAKE_HERDR_FAIL_START"]),
      );
      yield* waitFor(
        "recovered_relocation",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).filter((call) => call.at(-1) === target).length >
              startsBeforeRetry
          ),
        ),
      );
      assert.strictEqual((yield* stopRuntime(recovered)).exitCode, 0);
    })),
    20_000,
  );

  it.effect(
    "restarts a persisted Pi session when Herdr restored only stale pane metadata",
    () => Effect.scoped(Effect.gen(function*() {
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const paneId = "w1:p1";
      const persistedSession = paths.join(
        harness.state,
        "ghost-session.jsonl",
      );
      const agentCwd = yield* requireValue(
        harness.environment.AGENTOS_AGENT_CWD,
        "agent_cwd",
      );
      yield* writeJson(persistedSession, SessionHeader, {
        cwd: agentCwd,
        id: "session-ghost",
        type: "session",
        version: 3,
      });
      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: persistedSession },
          cwd: agentCwd,
          live: false,
          name: "firstmate",
          pane_id: paneId,
        }],
      );
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "stale_pane_restart",
        readCalls(harness.state).pipe(
          Effect.map((calls) =>
            startCalls(calls).some((call) => call.includes("--session"))
          ),
        ),
        300,
      );
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
      const calls = yield* readCalls(harness.state);
      assert.deepInclude(calls, [
        "pane",
        "process-info",
        "--pane",
        paneId,
        "--session",
        "agentos-firstmate-test",
      ]);
      assert.deepInclude(calls, [
        "pane",
        "close",
        paneId,
        "--session",
        "agentos-firstmate-test",
      ]);
    })),
    20_000,
  );

  it.effect(
    "fails closed when persisted identity is ambiguous",
    () => Effect.scoped(Effect.gen(function*() {
      const harness = yield* createHarness([
        { name: "firstmate" },
        { name: "firstmate" },
      ]);
      const result = yield* runProcess(
        "bun",
        [harness.paths.runMate],
        harness.environment,
      );
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(
        result.stderr,
        "Refusing to start: expected at most one Herdr agent named firstmate, found 2.\n",
      );
      assert.notInclude(result.stderr, "postgresql://");
      assert.deepStrictEqual(
        startCalls(yield* readCalls(harness.state)),
        [],
      );
    })),
    20_000,
  );

  it.effect(
    "fails closed without an explicit distribution root",
    () => Effect.scoped(Effect.gen(function*() {
      const harness = yield* createHarness([]);
      const result = yield* runProcess(
        "bun",
        [harness.paths.runMate],
        withoutEnvironment(harness.environment, [
          "AGENTOS_DISTRIBUTION_ROOT",
        ]),
      );
      assert.strictEqual(result.exitCode, 1);
      assert.include(result.stderr, "AGENTOS_DISTRIBUTION_ROOT");
      assert.deepStrictEqual(yield* readCalls(harness.state), []);
    })),
    20_000,
  );

  it.effect(
    "fails closed when the Pi working directory is outside the selected role",
    () => Effect.scoped(Effect.gen(function*() {
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: "/agentos/outside-selected-role",
      });
      const result = yield* runProcess(
        "bun",
        [harness.paths.runMate],
        harness.environment,
      );
      assert.strictEqual(result.exitCode, 1);
      assert.include(
        result.stderr,
        `AGENTOS_AGENT_CWD must equal ${harness.paths.defaultFirstMateCwd}`,
      );
      assert.deepStrictEqual(yield* readCalls(harness.state), []);
    })),
    20_000,
  );

  it.effect(
    "separates server liveness from required-agent readiness",
    () => Effect.scoped(Effect.gen(function*() {
      const paths = yield* Path.Path;
      const harness = yield* createHarness([]);
      const live = yield* runHealth(harness, "live");
      assert.deepStrictEqual(live, {
        exitCode: 0,
        stderr: "",
        stdout:
          '{"checks":[{"component":"herdr","status":"pass"}],"mode":"live","reasons":[],"role":"first_mate","status":"live","version":1}\n',
      });
      assert.strictEqual((yield* runHealth(harness, "ready")).exitCode, 1);

      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: harness.piSession },
          agent_status: "idle",
          cwd: harness.paths.defaultFirstMateCwd,
          foreground_cwd: harness.paths.defaultFirstMateCwd,
          live: false,
          name: "firstmate",
          pane_id: "w1:p1",
        }],
      );
      assert.strictEqual((yield* runHealth(harness, "ready")).exitCode, 1);

      yield* writeJson(
        paths.join(harness.state, "agents.json"),
        Agents,
        [{
          agent_session: { kind: "path", value: harness.piSession },
          agent_status: "idle",
          cwd: harness.paths.defaultFirstMateCwd,
          foreground_cwd: harness.paths.defaultFirstMateCwd,
          live: true,
          name: "firstmate",
          pane_id: "w1:p1",
        }],
      );
      const ready = yield* runHealth(harness, "ready");
      assert.strictEqual(ready.exitCode, 0);
      assert.deepInclude(yield* decodeJson(HealthResponse, ready.stdout), {
        mode: "ready",
        reasons: [],
        role: "first_mate",
        status: "ready",
        version: 1,
      });
    })),
    20_000,
  );

  it.effect(
    "runs and checks the configured Second Mate identity",
    () => Effect.scoped(Effect.gen(function*() {
      const paths = yield* Path.Path;
      const base = yield* runtimePaths();
      const secondMateCwd = paths.join(
        base.defaultDistributionRoot,
        "resources",
        "roles",
        "secondmate",
      );
      const harness = yield* createHarness([], {
        AGENTOS_AGENT_CWD: secondMateCwd,
        AGENTOS_AGENT_NAME: "delivery-second",
        AGENTOS_AGENT_ROLE: "second_mate",
        HERDR_SESSION: "agentos-delivery-second",
      });
      const expectedStart = [
        "agent",
        "start",
        "delivery-second",
        "--cwd",
        secondMateCwd,
        "--no-focus",
        "--session",
        "agentos-delivery-second",
        "--",
        "pi",
        "--no-context-files",
        "--continue",
      ];
      const child = yield* startRuntime(harness);
      yield* waitFor(
        "secondmate_start",
        readCalls(harness.state).pipe(
          Effect.map((calls) => callsMatch(calls, expectedStart)),
        ),
      );
      assert.strictEqual((yield* runHealth(harness, "ready")).exitCode, 0);
      assert.strictEqual((yield* stopRuntime(child)).exitCode, 0);
    })),
    20_000,
  );
});
