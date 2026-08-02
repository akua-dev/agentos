import * as BunServices from "@effect/platform-bun/BunServices";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Config,
  Effect,
  Exit,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
} from "effect";

import { BackgroundTaskBroker } from "./broker.ts";
import {
  restoreTaskLifecycle,
  TASK_LIFECYCLE_ENTRY,
  taskLifecycleEntry,
  type TaskLifecycleEntry,
} from "./lifecycle.ts";
import {
  backgroundTaskFailure,
  type BackgroundCommandRequest,
  type BackgroundTaskError,
  type CompletionDelivery,
  type StartBackgroundCommand,
  type TaskEvent,
  type TaskSnapshot,
  type TaskState,
} from "./types.ts";
import { environmentConfigLayer } from "../shared/platform.ts";
import { runAgentOSPiProgram } from "../pi-host-adapter.ts";

const MESSAGE_TYPE = "agentos-background-command-completion";

const RunBackgroundCommandParameters = Type.Object({
  command: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 36_000_000 })),
  ready_output: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4_096,
    description:
      "Literal stdout or stderr text that must appear before the start is reported as successful.",
  })),
  ready_timeout: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 600_000,
    description:
      "Maximum milliseconds to wait for ready_output; defaults to 30000.",
  })),
  completion_delivery: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
      description:
        "How natural completion is queued while Pi is streaming; defaults to followUp.",
    }),
  ),
});

const GetBackgroundCommandOutputParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 600_000 })),
  output_bytes: Type.Optional(Type.Number({ minimum: 0, maximum: 65_536 })),
});

const ListBackgroundCommandsParameters = Type.Object({
  state: Type.Optional(Type.Union([
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
    Type.Literal("cancelled"),
    Type.Literal("terminal"),
    Type.Literal("all"),
  ])),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  before_task_id: Type.Optional(Type.String({ minLength: 1 })),
});

const KillBackgroundCommandParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
});

export type AgentOSBackgroundTasksOptions = {
  readonly startCommand?: StartBackgroundCommand;
  readonly rootDirectory?: string;
  readonly createId?: () => Effect.Effect<string, BackgroundTaskError>;
  readonly batchDelayMs?: number;
};

export type BackgroundTaskCompletion = {
  readonly content: string;
  readonly deliverAs: CompletionDelivery;
  readonly taskIds: readonly string[];
};

export type AgentOSBackgroundTasksHost = {
  readonly appendLifecycle: (
    entry: TaskLifecycleEntry,
  ) => Effect.Effect<void, BackgroundTaskError>;
  readonly sendCompletion: (
    completion: BackgroundTaskCompletion,
  ) => Effect.Effect<void, BackgroundTaskError>;
};

const DEFAULT_TERMINAL_PAGE_LIMIT = 20;

type TaskListState = TaskState | "terminal" | "all";
type TaskListQuery = {
  readonly state: TaskListState;
  readonly limit: number;
  readonly beforeTaskId?: string;
};
type TaskListSelection = {
  readonly tasks: TaskSnapshot[];
  readonly nextCursor?: string;
};
export type AgentOSBackgroundTasksRuntime = {
  readonly broker: BackgroundTaskBroker;
  readonly run: (
    input: unknown,
  ) => Effect.Effect<AgentToolResult<TaskSnapshot>, BackgroundTaskError>;
  readonly output: (
    input: unknown,
  ) => Effect.Effect<AgentToolResult<TaskSnapshot>, BackgroundTaskError>;
  readonly list: (
    input: unknown,
  ) => Effect.Effect<AgentToolResult<TaskListSelection>, BackgroundTaskError>;
  readonly kill: (
    input: unknown,
  ) => Effect.Effect<AgentToolResult<TaskSnapshot>, BackgroundTaskError>;
  readonly listRunning: Effect.Effect<string, BackgroundTaskError>;
  readonly sessionStart: (
    entries: readonly unknown[],
  ) => Effect.Effect<void, BackgroundTaskError>;
  readonly sessionTree: Effect.Effect<void, BackgroundTaskError>;
  readonly shutdown: Effect.Effect<void>;
};
type WakeState = {
  readonly active: boolean;
  readonly pending: ReadonlySet<string>;
  readonly scheduled: boolean;
};

const NonBlankString = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.trim().length > 0, {
    expected: "a non-blank string",
  })),
);
const RunInputSchema = Schema.Struct({
  command: NonBlankString,
  description: NonBlankString,
  cwd: Schema.optional(NonBlankString),
  timeout: Schema.optional(boundedNumber(0, 36_000_000)),
  ready_output: Schema.optional(NonBlankString),
  ready_timeout: Schema.optional(boundedNumber(1, 600_000)),
  completion_delivery: Schema.optional(Schema.Literals(["steer", "followUp"])),
});
const OutputInputSchema = Schema.Struct({
  task_id: NonBlankString,
  timeout_ms: Schema.optional(boundedNumber(0, 600_000)),
  output_bytes: Schema.optional(boundedNumber(0, 65_536)),
});
const TaskListStateSchema = Schema.Literals([
  "running", "succeeded", "failed", "interrupted", "cancelled", "terminal", "all",
]);
const ListInputSchema = Schema.Struct({
  state: Schema.optional(TaskListStateSchema),
  limit: Schema.optional(boundedNumber(1, 100)),
  before_task_id: Schema.optional(NonBlankString),
});
const KillInputSchema = Schema.Struct({ task_id: NonBlankString });

const BackgroundTasksConfig = Config.all({
  rootDirectory: Config.option(Config.string("AGENTOS_BACKGROUND_TASK_DIR")),
  home: Config.option(Config.string("HOME")),
});

export const registerAgentosBackgroundTasksEffect = Effect.fn(
  "agentos.backgroundTasks.extension.register",
)(function*(
  pi: ExtensionAPI,
  options: AgentOSBackgroundTasksOptions = {},
) {
  return yield* Effect.gen(function*() {
      const runtime = yield* makeAgentosBackgroundTasks(piHost(pi), options);
      registerPiBackgroundTasks(pi, runtime);
      return runtime.broker;
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(environmentConfigLayer()),
  );
});

export function registerAgentosBackgroundTasks(
  pi: ExtensionAPI,
  options: AgentOSBackgroundTasksOptions = {},
) {
  return runAgentOSPiProgram(
    registerAgentosBackgroundTasksEffect(pi, options),
  );
}

export const makeAgentosBackgroundTasks = Effect.fn(
  "agentos.backgroundTasks.extension.make",
)(function*(
  host: AgentOSBackgroundTasksHost,
  options: AgentOSBackgroundTasksOptions = {},
) {
  const paths = yield* Path.Path;
  const configured = yield* BackgroundTasksConfig;
  const rootDirectory = options.rootDirectory ??
    Option.getOrUndefined(configured.rootDirectory) ??
    paths.join(
      Option.getOrUndefined(configured.home) ?? paths.resolve("."),
      ".local",
      "state",
      "agentos",
      "background-commands",
    );
  const runtimeScope = yield* Scope.make();
  const broker = yield* BackgroundTaskBroker.make({
    rootDirectory,
    startCommand: options.startCommand,
    createId: options.createId,
  }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
  const batchDelayMs = options.batchDelayMs ?? 100;
  const wakeState = yield* Ref.make<WakeState>({
    active: true,
    pending: new Set(),
    scheduled: false,
  });
  const restored = yield* Ref.make(false);

  let flush: Effect.Effect<void, BackgroundTaskError>;

  function scheduleFlush(delayMillis: number): Effect.Effect<void> {
    return Effect.gen(function*() {
      const schedule = yield* Ref.modify(wakeState, (state) => {
        if (!state.active || state.scheduled || state.pending.size === 0) {
          return [false, state];
        }
        return [true, { ...state, scheduled: true }];
      });
      if (!schedule) return;
      yield* Effect.sleep(Math.max(0, delayMillis)).pipe(
        Effect.andThen(flush),
        Effect.forkIn(runtimeScope, { startImmediately: true }),
      );
    });
  }

  flush = Effect.gen(function*() {
    const taskIds = yield* Ref.modify(wakeState, (state) => {
      if (!state.active || state.pending.size === 0) {
        return [[], { ...state, scheduled: false }];
      }
      return [[...state.pending], {
        ...state,
        pending: new Set<string>(),
        scheduled: false,
      }];
    });
    if (taskIds.length === 0) return;
    const tasks = (yield* Effect.forEach(taskIds, (id) => broker.get(id))).filter(
      taskNeedsWake,
    );
    const groups = new Map<CompletionDelivery, TaskSnapshot[]>([
      ["steer", []],
      ["followUp", []],
    ]);
    for (const task of tasks) {
      const group = groups.get(task.completionDelivery);
      if (group !== undefined) group.push(task);
    }
    for (const [deliverAs, group] of groups) {
      if (group.length === 0) continue;
      const delivered = yield* Effect.result(host.sendCompletion({
        content: completionMessage(group),
        deliverAs,
        taskIds: group.map(({ id }) => id),
      }));
      if (Result.isFailure(delivered)) {
        yield* Ref.update(wakeState, (state) => ({
          ...state,
          pending: new Set([...state.pending, ...group.map(({ id }) => id)]),
        }));
      }
    }
    yield* scheduleFlush(Math.max(1_000, batchDelayMs));
  });

  const unsubscribe = yield* broker.onEvent((event) =>
    Effect.gen(function*() {
      yield* host.appendLifecycle(taskLifecycleEntry(event.task)).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to append background task lifecycle", {
            error: error.message,
            taskId: event.task.id,
          })
        ),
      );
      if (!eligibleForWake(event)) return;
      yield* Ref.update(wakeState, (state) => ({
        ...state,
        pending: new Set([...state.pending, event.task.id]),
      }));
      yield* scheduleFlush(batchDelayMs);
    }));

  const run = (input: unknown) =>
    Effect.gen(function*() {
      const request = yield* parseRequest(input);
      const task = yield* broker.start(request);
      return result(task, formatStart(task));
    });
  const output = (input: unknown) =>
    Effect.gen(function*() {
      const params = yield* decodeInput(OutputInputSchema, input);
      const task = yield* broker.get(params.task_id, {
        waitMs: params.timeout_ms,
        outputBytes: params.output_bytes,
        observeCompletion: true,
      });
      return result(task, formatTaskWithOutput(task));
    });
  const list = (input: unknown) =>
    Effect.gen(function*() {
      const tasks = yield* broker.list();
      const query = yield* parseTaskListQuery(input);
      const selection = yield* selectTaskList(tasks, query);
      return result(selection, formatTaskList(selection));
    });
  const kill = (input: unknown) =>
    Effect.gen(function*() {
      const params = yield* decodeInput(KillInputSchema, input);
      const task = yield* broker.kill(params.task_id);
      return result(task, `Killed background command "${task.id}".`);
    });
  const listRunning = Effect.gen(function*() {
    const tasks = yield* broker.list();
    const selection = yield* selectTaskList(tasks, {
      state: "running",
      limit: DEFAULT_TERMINAL_PAGE_LIMIT,
    });
    return formatTaskList(selection);
  });
  const sessionStart = (entries: readonly unknown[]) =>
    Effect.gen(function*() {
      yield* Ref.update(wakeState, (state) => ({ ...state, active: true }));
      const alreadyRestored = yield* Ref.getAndSet(restored, true);
      if (alreadyRestored) return;
      const lifecycle = restoreTaskLifecycle(entries);
      yield* broker.restore(lifecycle.tasks);
      for (const task of lifecycle.interrupted) {
        yield* host.appendLifecycle(taskLifecycleEntry(task));
      }
  });
  const sessionTree = Effect.gen(function*() {
    for (const task of yield* broker.list()) {
      if (task.state === "running") {
        yield* host.appendLifecycle(taskLifecycleEntry(task));
      }
    }
  });
  const shutdown = Effect.gen(function*() {
    yield* Ref.set(wakeState, {
      active: false,
      pending: new Set<string>(),
      scheduled: false,
    });
    yield* unsubscribe;
    yield* broker.shutdown;
    yield* Scope.close(runtimeScope, Exit.void);
  });

  return {
    broker,
    kill,
    list,
    listRunning,
    output,
    run,
    sessionStart,
    sessionTree,
    shutdown,
  } satisfies AgentOSBackgroundTasksRuntime;
});

function piHost(pi: ExtensionAPI): AgentOSBackgroundTasksHost {
  return {
    appendLifecycle: (entry) =>
      piOperation("append task lifecycle", () =>
        pi.appendEntry(TASK_LIFECYCLE_ENTRY, entry)),
    sendCompletion: (completion) =>
      piOperation("send completion message", () =>
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: completion.content,
          display: true,
          details: { taskIds: completion.taskIds },
        }, {
          deliverAs: completion.deliverAs,
          triggerTurn: true,
        })),
  };
}

function registerPiBackgroundTasks(
  pi: ExtensionAPI,
  runtime: AgentOSBackgroundTasksRuntime,
) {
  pi.registerTool({
    name: "run_background_command",
    label: "Run background command",
    description:
      "Run one shell command in the background and return with a stable task ID and file-backed output path. When ready_output is set, return only after that literal output is observed.",
    promptSnippet:
      "Run long-lived native commands in the background and pull output only when needed",
    promptGuidelines: [
      "Use native CLI commands directly; do not append shell & or add an AgentOS domain wrapper.",
      "You are notified on natural completion, so do not poll or sleep-wait.",
      "Use ready_output when later work must not race a native command's explicit readiness signal. Startup proof defaults to a 30-second bound; override ready_timeout only for a reviewed different bound.",
      "Select completion_delivery=steer only when completion can invalidate the next model action; routine work stays on the default followUp path.",
      "Never put credentials in the command string; use approved environment or native config.",
    ],
    parameters: RunBackgroundCommandParameters,
    execute(_toolCallId, params) {
      return runAgentOSPiProgram(runtime.run(params));
    },
  });
  pi.registerTool({
    name: "get_background_command_output",
    label: "Get background command output",
    description:
      "Get status and bounded output from one background command, optionally waiting for completion.",
    parameters: GetBackgroundCommandOutputParameters,
    execute(_toolCallId, params) {
      return runAgentOSPiProgram(runtime.output(params));
    },
  });
  pi.registerTool({
    name: "list_background_commands",
    label: "List background commands",
    description:
      "List background commands without output. Defaults to every running command; select a terminal state with a bounded page and optional older-page cursor.",
    parameters: ListBackgroundCommandsParameters,
    execute(_toolCallId, params) {
      return runAgentOSPiProgram(runtime.list(params));
    },
  });
  pi.registerTool({
    name: "kill_background_command",
    label: "Kill background command",
    description:
      "Stop one owned background command. The explicit kill response consumes its completion notification.",
    parameters: KillBackgroundCommandParameters,
    execute(_toolCallId, params) {
      return runAgentOSPiProgram(runtime.kill(params));
    },
  });
  pi.registerCommand("background-commands", {
    description: "List AgentOS background commands",
    handler(_arguments, context) {
      return runAgentOSPiProgram(runtime.listRunning.pipe(
        Effect.flatMap((message) =>
          piOperation("notify background command list", () =>
            context.ui.notify(message, "info"))
        ),
      ));
    },
  });
  pi.on("session_start", (_event, context) =>
    runAgentOSPiProgram(
      piOperation(
        "read session branch",
        () => context.sessionManager.getBranch(),
      ).pipe(Effect.flatMap(runtime.sessionStart)),
    ));
  pi.on("session_tree", () => runAgentOSPiProgram(runtime.sessionTree));
  pi.on("session_shutdown", () => runAgentOSPiProgram(runtime.shutdown));
}

export default registerAgentosBackgroundTasks;

function eligibleForWake(event: TaskEvent) {
  return event.type === "task_terminal" && taskNeedsWake(event.task);
}

function taskNeedsWake(task: TaskSnapshot) {
  return !task.completionObserved &&
    !task.explicitlyKilled &&
    task.state !== "cancelled";
}

function completionMessage(tasks: TaskSnapshot[]) {
  return tasks.map(formatCompletion).join("\n\n");
}

function formatCompletion(task: TaskSnapshot) {
  const duration = ((task.durationMs ?? 0) / 1_000).toFixed(1);
  const status = task.error
    ? `error: ${task.error}`
    : task.signal
      ? `signal ${task.signal}`
      : `exit code ${task.exitCode ?? "unknown"}`;
  return [
    `Background command "${task.id}" completed (${status}).`,
    `Description: ${task.description}`,
    `Duration: ${duration}s`,
    `Use get_background_command_output with task_id "${task.id}" only if the command output itself is useful.`,
  ].join("\n");
}

function result<T>(details: T, text: string): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function formatTask(task: TaskSnapshot) {
  const status = task.signal
    ? ` signal=${task.signal}`
    : task.exitCode === undefined
      ? ""
      : ` exit=${task.exitCode ?? "unknown"}`;
  return `${task.id} ${task.state}${status} ${task.description}`;
}

function selectTaskList(tasks: TaskSnapshot[], query: TaskListQuery) {
  const running = tasks.filter(({ state }) => state === "running");
  if (query.state === "running") {
    return Effect.succeed<TaskListSelection>({ tasks: running });
  }
  let terminal = tasks
    .filter(({ state }) => state !== "running")
    .reverse()
    .sort(compareTerminalRecency);
  if (query.state !== "all" && query.state !== "terminal") {
    terminal = terminal.filter(({ state }) => state === query.state);
  }
  if (query.beforeTaskId !== undefined) {
    const cursor = terminal.findIndex(({ id }) => id === query.beforeTaskId);
    if (cursor < 0) {
      return Effect.fail(backgroundTaskFailure(
        "unknown_task",
        `Unknown background command cursor: ${query.beforeTaskId}`,
      ));
    }
    terminal = terminal.slice(cursor + 1);
  }
  const page = terminal.slice(0, query.limit);
  const nextCursor = terminal.length > page.length ? page.at(-1)?.id : undefined;
  return Effect.succeed<TaskListSelection>({
    tasks: query.state === "all" ? [...running, ...page] : page,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function compareTerminalRecency(left: TaskSnapshot, right: TaskSnapshot) {
  return terminalTimestamp(right).localeCompare(terminalTimestamp(left));
}

function terminalTimestamp(task: TaskSnapshot) {
  return task.finishedAt ?? task.startedAt;
}

function formatTaskList(selection: TaskListSelection) {
  if (selection.tasks.length === 0) return "No background commands.";
  const lines = selection.tasks.map(formatTask);
  if (selection.nextCursor !== undefined) {
    lines.push(
      `More terminal commands available; pass before_task_id "${selection.nextCursor}".`,
    );
  }
  return lines.join("\n");
}

function formatTaskWithOutput(task: TaskSnapshot) {
  const error = task.error ? `\nError: ${task.error}` : "";
  const output = task.outputTail
    ? `\n\nOutput${task.outputTruncated ? " tail" : ""}:\n${task.outputTail}`
    : "";
  return `${formatTask(task)}\nCommand: ${task.command}\nOutput file: ${task.outputPath}${error}${output}`;
}

function formatStart(task: TaskSnapshot) {
  return task.state === "running"
    ? `Started background command "${task.id}": ${task.description}\nOutput: ${task.outputPath}`
    : `Background command "${task.id}" ${task.state} before the start response.\n${formatTaskWithOutput(task)}`;
}

function parseRequest(input: unknown) {
  return Effect.gen(function*() {
    const params = yield* decodeInput(RunInputSchema, input);
    if (params.ready_timeout !== undefined && params.ready_output === undefined) {
      return yield* Effect.fail(backgroundTaskFailure(
        "invalid_request",
        "ready_timeout requires ready_output",
      ));
    }
    return {
      command: params.command,
      description: params.description,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.timeout === undefined ? {} : { timeout: Math.floor(params.timeout) }),
      ...(params.ready_output === undefined ? {} : { readyOutput: params.ready_output }),
      ...(params.ready_timeout === undefined
        ? {}
        : { readyTimeout: Math.floor(params.ready_timeout) }),
      ...(params.completion_delivery === undefined
        ? {}
        : { completionDelivery: params.completion_delivery }),
    } satisfies BackgroundCommandRequest;
  });
}

function parseTaskListQuery(input: unknown) {
  return decodeInput(ListInputSchema, input).pipe(
    Effect.flatMap((params) => {
      const state = params.state ?? "running";
      if (state === "running" && params.before_task_id !== undefined) {
        return Effect.fail(backgroundTaskFailure(
          "invalid_request",
          "before_task_id requires a terminal state or all",
        ));
      }
      return Effect.succeed<TaskListQuery>({
        state,
        limit: Math.floor(params.limit ?? DEFAULT_TERMINAL_PAGE_LIMIT),
        ...(params.before_task_id === undefined
          ? {}
          : { beforeTaskId: params.before_task_id }),
      });
    }),
  );
}

function decodeInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
) {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((cause) =>
      backgroundTaskFailure(
        "invalid_request",
        `Invalid background command input: ${String(cause)}`,
        cause,
      )
    ),
  );
}

function boundedNumber(minimum: number, maximum: number) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isFinite(),
      Schema.isGreaterThanOrEqualTo(minimum),
      Schema.isLessThanOrEqualTo(maximum),
    ),
  );
}

function piOperation<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      backgroundTaskFailure(
        "runtime_failure",
        `Failed to ${operation}`,
        cause,
      ),
  });
}
