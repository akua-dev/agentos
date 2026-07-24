import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { assertSafeBackgroundRequest } from "./command.ts";
import { BackgroundTaskBroker } from "./broker.ts";
import {
  restoreTaskLifecycle,
  TASK_LIFECYCLE_ENTRY,
  taskLifecycleEntry,
} from "./lifecycle.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskEvent,
  TaskSnapshot,
  TaskState,
} from "./types.ts";

const MESSAGE_TYPE = "agentos-background-command-completion";

const RunBackgroundCommandParameters = Type.Object({
  command: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 36_000_000 })),
  ready_output: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        "Literal stdout or stderr text that must appear before the start is reported as successful.",
    }),
  ),
  ready_timeout: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 600_000,
      description:
        "Maximum milliseconds to wait for ready_output; defaults to 30000.",
    }),
  ),
});

const GetBackgroundCommandOutputParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
  timeout_ms: Type.Optional(
    Type.Number({ minimum: 0, maximum: 600_000 }),
  ),
  output_bytes: Type.Optional(
    Type.Number({ minimum: 0, maximum: 65_536 }),
  ),
});

const ListBackgroundCommandsParameters = Type.Object({
  state: Type.Optional(
    Type.Union([
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("cancelled"),
      Type.Literal("terminal"),
      Type.Literal("all"),
    ]),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  before_task_id: Type.Optional(Type.String({ minLength: 1 })),
});

const KillBackgroundCommandParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
});

type ExtensionOptions = {
  startCommand?: StartBackgroundCommand;
  rootDirectory?: string;
  createId?: () => string;
  batchDelayMs?: number;
};

const DEFAULT_TERMINAL_PAGE_LIMIT = 20;

type TaskListState = TaskState | "terminal" | "all";

type TaskListQuery = {
  state: TaskListState;
  limit: number;
  beforeTaskId?: string;
};

type TaskListSelection = {
  tasks: TaskSnapshot[];
  nextCursor?: string;
};

export function registerAgentosBackgroundTasks(
  pi: ExtensionAPI,
  options: ExtensionOptions = {},
) {
  const rootDirectory =
    options.rootDirectory ??
    process.env.AGENTOS_BACKGROUND_TASK_DIR ??
    join(
      process.env.HOME ?? process.cwd(),
      ".local",
      "state",
      "agentos",
      "background-commands",
    );
  const broker = new BackgroundTaskBroker({
    rootDirectory,
    startCommand: options.startCommand,
    createId: options.createId,
  });
  const pending = new Set<string>();
  const batchDelayMs = options.batchDelayMs ?? 100;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let restored = false;

  broker.onEvent((event) => {
    pi.appendEntry(TASK_LIFECYCLE_ENTRY, taskLifecycleEntry(event.task));
    if (!eligibleForWake(event)) return;
    pending.add(event.task.id);
    scheduleFlush();
  });

  function scheduleFlush(delay = batchDelayMs) {
    if (!active || batchTimer || pending.size === 0) return;
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      void flush();
    }, delay);
  }

  async function flush() {
    if (!active || pending.size === 0) return;
    const taskIds = [...pending];
    pending.clear();
    const tasks = (await Promise.all(taskIds.map((id) => broker.get(id)))).filter(
      taskNeedsWake,
    );
    if (tasks.length === 0) return;
    try {
      await pi.sendMessage(
        {
          customType: MESSAGE_TYPE,
          content: completionMessage(tasks),
          display: true,
          details: { taskIds: tasks.map(({ id }) => id) },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      if (!active) return;
      for (const task of tasks) pending.add(task.id);
      scheduleFlush(Math.max(1_000, batchDelayMs));
    }
  }

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
      "Never put credentials in the command string; use approved environment or native config.",
    ],
    parameters: RunBackgroundCommandParameters,
    async execute(_toolCallId, params) {
      const request = parseRequest(params);
      const task = await broker.start(request);
      return result(task, formatStart(task));
    },
  });

  pi.registerTool({
    name: "get_background_command_output",
    label: "Get background command output",
    description:
      "Get status and bounded output from one background command, optionally waiting for completion.",
    parameters: GetBackgroundCommandOutputParameters,
    async execute(_toolCallId, params) {
      const task = await broker.get(requiredString(params, "task_id"), {
        waitMs: optionalBoundedNumber(params, "timeout_ms", 0, 600_000),
        outputBytes: optionalBoundedNumber(params, "output_bytes", 0, 65_536),
        observeCompletion: true,
      });
      return result(task, formatTaskWithOutput(task));
    },
  });

  pi.registerTool({
    name: "list_background_commands",
    label: "List background commands",
    description:
      "List background commands without output. Defaults to every running command; select a terminal state with a bounded page and optional older-page cursor.",
    parameters: ListBackgroundCommandsParameters,
    async execute(_toolCallId, params) {
      const tasks = await broker.list();
      const selection = selectTaskList(tasks, parseTaskListQuery(params));
      return result(selection, formatTaskList(selection));
    },
  });

  pi.registerTool({
    name: "kill_background_command",
    label: "Kill background command",
    description:
      "Stop one owned background command. The explicit kill response consumes its completion notification.",
    parameters: KillBackgroundCommandParameters,
    async execute(_toolCallId, params) {
      const task = await broker.kill(requiredString(params, "task_id"));
      return result(task, `Killed background command "${task.id}".`);
    },
  });

  pi.registerCommand("background-commands", {
    description: "List AgentOS background commands",
    handler: async (_args, context) => {
      const tasks = await broker.list();
      context.ui.notify(
        formatTaskList(
          selectTaskList(tasks, {
            state: "running",
            limit: DEFAULT_TERMINAL_PAGE_LIMIT,
          }),
        ),
        "info",
      );
    },
  });

  pi.on("session_start", (_event, context) => {
    active = true;
    if (restored) return;
    restored = true;
    const lifecycle = restoreTaskLifecycle(
      context.sessionManager.getBranch(),
    );
    broker.restore(lifecycle.tasks);
    for (const task of lifecycle.interrupted) {
      pi.appendEntry(TASK_LIFECYCLE_ENTRY, taskLifecycleEntry(task));
    }
  });

  pi.on("session_tree", async () => {
    for (const task of await broker.list()) {
      if (task.state === "running") {
        pi.appendEntry(TASK_LIFECYCLE_ENTRY, taskLifecycleEntry(task));
      }
    }
  });

  pi.on("session_shutdown", async () => {
    active = false;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = undefined;
    pending.clear();
    await broker.shutdown();
  });

  return broker;
}

export default registerAgentosBackgroundTasks;

function eligibleForWake(event: TaskEvent) {
  if (event.type !== "task_terminal") return false;
  return taskNeedsWake(event.task);
}

function taskNeedsWake(task: TaskSnapshot) {
  return (
    !task.completionObserved &&
    !task.explicitlyKilled &&
    task.state !== "cancelled"
  );
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
    `Command: ${task.command} | Duration: ${duration}s`,
    `Use get_background_command_output with task_id "${task.id}" to inspect output.`,
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

function selectTaskList(
  tasks: TaskSnapshot[],
  query: TaskListQuery,
): TaskListSelection {
  const running = tasks.filter(({ state }) => state === "running");
  if (query.state === "running") return { tasks: running };

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
      throw new Error(
        `Unknown background command cursor: ${query.beforeTaskId}`,
      );
    }
    terminal = terminal.slice(cursor + 1);
  }
  const page = terminal.slice(0, query.limit);
  const nextCursor =
    terminal.length > page.length ? page.at(-1)?.id : undefined;
  return {
    tasks: query.state === "all" ? [...running, ...page] : page,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function compareTerminalRecency(left: TaskSnapshot, right: TaskSnapshot) {
  return terminalTimestamp(right).localeCompare(
    terminalTimestamp(left),
  );
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
  if (task.state === "running") {
    return `Started background command "${task.id}": ${task.description}\nOutput: ${task.outputPath}`;
  }
  return `Background command "${task.id}" ${task.state} before the start response.\n${formatTaskWithOutput(task)}`;
}

function parseRequest(params: Record<string, unknown>): BackgroundCommandRequest {
  const request: BackgroundCommandRequest = {
    command: requiredString(params, "command"),
    description: requiredString(params, "description"),
    ...(params.cwd === undefined ? {} : { cwd: requiredString(params, "cwd") }),
    ...(params.timeout === undefined
      ? {}
      : { timeout: optionalBoundedNumber(params, "timeout", 0, 36_000_000)! }),
    ...(params.ready_output === undefined
      ? {}
      : { readyOutput: requiredString(params, "ready_output") }),
    ...(params.ready_timeout === undefined
      ? {}
      : {
          readyTimeout: optionalBoundedNumber(
            params,
            "ready_timeout",
            1,
            600_000,
          )!,
        }),
  };
  assertSafeBackgroundRequest(request);
  return request;
}

function parseTaskListQuery(
  params: Record<string, unknown>,
): TaskListQuery {
  const state = taskListState(params.state);
  const beforeTaskId =
    params.before_task_id === undefined
      ? undefined
      : requiredString(params, "before_task_id");
  if (state === "running" && beforeTaskId !== undefined) {
    throw new Error("before_task_id requires a terminal state or all");
  }
  return {
    state,
    limit:
      optionalBoundedNumber(params, "limit", 1, 100) ??
      DEFAULT_TERMINAL_PAGE_LIMIT,
    ...(beforeTaskId === undefined ? {} : { beforeTaskId }),
  };
}

function taskListState(value: unknown): TaskListState {
  if (value === undefined) return "running";
  if (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled" ||
    value === "terminal" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("state is not a supported background command state");
}

function requiredString(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalBoundedNumber(
  params: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
) {
  const value = params[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return Math.floor(value);
}
