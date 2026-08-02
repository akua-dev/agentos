#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const argumentSeparator = "\u001f";
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
const AgentsFromJson = Schema.fromJsonString(Schema.Array(Agent));
const CallFromJson = Schema.fromJsonString(Schema.Array(Schema.String));
const AgentListResponse = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(Agent),
    type: Schema.Literal("agent_list"),
  }),
});
const AgentStartedResponse = Schema.Struct({
  result: Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("agent_started"),
  }),
});
const AgentInfoResponse = Schema.Struct({
  result: Schema.Struct({
    agent: Agent,
    type: Schema.Literal("agent_info"),
  }),
});
const ServerStatusResponse = Schema.Struct({
  result: Schema.Struct({
    running: Schema.Boolean,
    type: Schema.Literal("server_status"),
  }),
});
const ExplainResponse = Schema.Struct({
  agent: Schema.String,
  state: Schema.String,
});
const ProcessInfoResponse = Schema.Struct({
  result: Schema.Struct({
    process_info: Schema.Struct({
      foreground_process_group_id: Schema.Number,
      foreground_processes: Schema.Array(Schema.Struct({
        argv0: Schema.String,
        cwd: Schema.optional(Schema.String),
        pid: Schema.Number,
      })),
      pane_id: Schema.String,
    }),
    type: Schema.Literal("pane_process_info"),
  }),
});

class FakeHerdrError extends Schema.TaggedErrorClass<FakeHerdrError>()(
  "FakeHerdrError",
  { operation: Schema.String },
) {}

const fakeError = (operation: string) => FakeHerdrError.make({ operation });
const FakeHerdrConfig = Config.all({
  agentKind: Config.option(Config.string("FAKE_HERDR_AGENT_KIND")),
  agentStatus: Config.option(Config.string("FAKE_HERDR_AGENT_STATUS")),
  arguments: Config.string("FAKE_HERDR_ARGUMENTS"),
  failStart: Config.option(Config.string("FAKE_HERDR_FAIL_START")),
  nodePath: Config.option(Config.string("NODE_PATH")),
  parentProcessId: Config.int("FAKE_HERDR_PARENT_PID"),
  path: Config.string("PATH"),
  piExtension: Config.option(Config.string("FAKE_PI_EXTENSION")),
  piSession: Config.option(Config.string("FAKE_PI_SESSION")),
  state: Config.string("FAKE_HERDR_STATE"),
});

function decodeArguments(source: string) {
  const values = source.split(argumentSeparator);
  return values.at(-1) === "" ? values.slice(0, -1) : values;
}

function encodeJson<S extends Schema.Constraint>(schema: S, value: S["Type"]) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value);
}

const printJson = Effect.fn("test.fakeHerdr.printJson")(function*<S extends Schema.Constraint>(
  schema: S,
  value: S["Type"],
) {
  const stdio = yield* Stdio.Stdio;
  const source = yield* encodeJson(schema, value);
  yield* Stream.make(`${source}\n`).pipe(Stream.run(stdio.stdout()));
});

const readAgents = Effect.fn("test.fakeHerdr.readAgents")(function*(state: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  return yield* fileSystem.readFileString(paths.join(state, "agents.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgentsFromJson)),
  );
});

const writeAgents = Effect.fn("test.fakeHerdr.writeAgents")(function*(
  state: string,
  agents: ReadonlyArray<Agent>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const source = yield* Schema.encodeEffect(AgentsFromJson)(agents);
  yield* fileSystem.writeFileString(paths.join(state, "agents.json"), source);
});

const appendCall = Effect.fn("test.fakeHerdr.appendCall")(function*(
  state: string,
  arguments_: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const source = yield* Schema.encodeEffect(CallFromJson)(arguments_);
  yield* fileSystem.writeFileString(
    paths.join(state, "calls.jsonl"),
    `${source}\n`,
    { flag: "a" },
  );
});

function argumentAfter(arguments_: ReadonlyArray<string>, flag: string) {
  const value = arguments_[arguments_.indexOf(flag) + 1];
  return value === undefined
    ? Effect.fail(fakeError(`missing_${flag}`))
    : Effect.succeed(value);
}

const runExtension = Effect.fn("test.fakeHerdr.runExtension")(function*(
  extension: string,
  state: string,
  nodePath: Option.Option<string>,
  executablePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const environment = Option.match(nodePath, {
    onNone: () => ({ FAKE_HERDR_STATE: state, PATH: executablePath }),
    onSome: (value) => ({
      FAKE_HERDR_STATE: state,
      NODE_PATH: value,
      PATH: executablePath,
    }),
  });
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("node", [extension], {
      env: environment,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(Effect.mapError(() => fakeError("extension_process")));
  yield* Effect.all([
    fileSystem.writeFileString(paths.join(state, "child-stdout"), result.stdout),
    fileSystem.writeFileString(paths.join(state, "child-stderr"), result.stderr),
    fileSystem.writeFileString(
      paths.join(state, "child-result"),
      result.stdout.trim(),
    ),
  ], { concurrency: "unbounded", discard: true });
  if (result.exitCode !== 0) return yield* fakeError("extension_exit");
});

const parentIsRunning = Effect.fn("test.fakeHerdr.parentIsRunning")(
  function*(processId: number) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make(
        "kill",
        ["-0", String(processId)],
        { stderr: "ignore", stdout: "ignore" },
      );
      return Number(yield* child.exitCode) === 0;
    })).pipe(Effect.mapError(() => fakeError("parent_probe")));
  },
);

const waitForParentExit = Effect.fn("test.fakeHerdr.waitForParentExit")(
  function*(processId: number) {
    while (yield* parentIsRunning(processId)) {
      yield* Effect.sleep("50 millis");
    }
  },
);

export const fakeHerdr = Effect.gen(function*() {
  const config = yield* FakeHerdrConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const arguments_ = decodeArguments(config.arguments);
  yield* appendCall(config.state, arguments_);
  const command = arguments_.slice(0, 2).join(" ");

  if (arguments_[0] === "server") {
    yield* Effect.all([
      fileSystem.writeFileString(
        paths.join(config.state, "server-node-path"),
        Option.getOrElse(config.nodePath, () => ""),
      ),
      fileSystem.writeFileString(paths.join(config.state, "server-ready"), "ready\n"),
    ], { concurrency: "unbounded", discard: true });
    return yield* waitForParentExit(config.parentProcessId);
  }

  if (arguments_[0] === "status") {
    return yield* printJson(ServerStatusResponse, {
      result: { running: true, type: "server_status" },
    });
  }

  if (command === "agent list") {
    return yield* printJson(AgentListResponse, {
      result: {
        agents: yield* readAgents(config.state),
        type: "agent_list",
      },
    });
  }

  if (command === "agent start") {
    if (Option.getOrElse(config.failStart, () => "") === "1") {
      return yield* fakeError("configured_start_failure");
    }
    const name = arguments_[2];
    if (name === undefined) return yield* fakeError("missing_agent_name");
    const cwd = yield* argumentAfter(arguments_, "--cwd");
    const base = {
      agent_status: "idle",
      cwd,
      foreground_cwd: cwd,
      live: true,
      name,
      pane_id: "w-started:p1",
    };
    const started: Agent = Option.match(config.piSession, {
      onNone: () => base,
      onSome: (value) => ({
        ...base,
        agent_session: { kind: "path", value },
      }),
    });
    yield* writeAgents(config.state, [
      ...yield* readAgents(config.state),
      started,
    ]);
    if (Option.isSome(config.piExtension)) {
      yield* runExtension(
        config.piExtension.value,
        config.state,
        config.nodePath,
        config.path,
      );
    }
    return yield* printJson(AgentStartedResponse, {
      result: { name, type: "agent_started" },
    });
  }

  if (command === "agent get") {
    const name = arguments_[2];
    const agent = (yield* readAgents(config.state)).find(
      (candidate) => candidate.name === name,
    );
    if (agent === undefined) return yield* fakeError("agent_not_found");
    return yield* printJson(AgentInfoResponse, {
      result: { agent, type: "agent_info" },
    });
  }

  if (command === "agent explain") {
    return yield* printJson(ExplainResponse, {
      agent: Option.getOrElse(config.agentKind, () => "pi"),
      state: Option.getOrElse(config.agentStatus, () => "idle"),
    });
  }

  if (command === "pane process-info") {
    const pane = yield* argumentAfter(arguments_, "--pane");
    const agent = (yield* readAgents(config.state)).find(
      (candidate) => candidate.pane_id === pane && candidate.live === true,
    );
    if (agent === undefined) return yield* fakeError("live_pane_not_found");
    return yield* printJson(ProcessInfoResponse, {
      result: {
        process_info: {
          foreground_process_group_id: 4242,
          foreground_processes: [{
            argv0: Option.getOrElse(config.agentKind, () => "pi"),
            cwd: agent.foreground_cwd ?? agent.cwd,
            pid: 4242,
          }],
          pane_id: pane,
        },
        type: "pane_process_info",
      },
    });
  }

  if (command === "pane close") {
    const pane = arguments_[2];
    yield* writeAgents(
      config.state,
      (yield* readAgents(config.state)).filter(
        (candidate) => candidate.pane_id !== pane,
      ),
    );
    return;
  }

  if (arguments_.slice(0, 3).join(" ") === "terminal session observe") {
    return yield* Effect.never;
  }
});

if (import.meta.main) {
  BunRuntime.runMain(
    fakeHerdr.pipe(Effect.provide(BunServices.layer)),
    { disableErrorReporting: true },
  );
}
