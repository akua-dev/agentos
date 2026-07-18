import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { assertSafeBackgroundRequest } from "./command.ts";
import { BackgroundTaskBroker } from "./broker.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskEvent,
  TaskSnapshot,
} from "./types.ts";

const MESSAGE_TYPE = "agentos-background-command-completion";

const RunBackgroundCommandParameters = Type.Object({
  command: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 36_000_000 })),
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

const ListBackgroundCommandsParameters = Type.Object({});

const KillBackgroundCommandParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
});

type ExtensionOptions = {
  startCommand?: StartBackgroundCommand;
  rootDirectory?: string;
  createId?: () => string;
  batchDelayMs?: number;
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

  broker.onEvent((event) => {
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
      "Run one shell command in the background and return immediately with a stable task ID and file-backed output path.",
    promptSnippet:
      "Run long-lived native commands in the background and pull output only when needed",
    promptGuidelines: [
      "Use native CLI commands directly; do not append shell & or add an AgentOS domain wrapper.",
      "You are notified on natural completion, so do not poll or sleep-wait.",
      "Never put credentials in the command string; use approved environment or native config.",
    ],
    parameters: RunBackgroundCommandParameters,
    async execute(_toolCallId, params) {
      const request = parseRequest(params);
      const task = await broker.start(request);
      return result(
        task,
        `Started background command "${task.id}": ${task.description}\nOutput: ${task.outputPath}`,
      );
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
    description: "List running and recent background commands without their output.",
    parameters: ListBackgroundCommandsParameters,
    async execute() {
      const tasks = await broker.list();
      return result(
        tasks,
        tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No background commands.",
      );
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
        tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No background commands.",
        "info",
      );
    },
  });

  pi.on("session_start", () => {
    active = true;
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
  const status = task.error
    ? `error: ${task.error}`
    : task.signal
      ? `signal ${task.signal}`
      : `exit code ${task.exitCode ?? "unknown"}`;
  const duration = ((task.durationMs ?? 0) / 1_000).toFixed(1);
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
    ? `signal=${task.signal}`
    : task.exitCode === undefined
      ? ""
      : ` exit=${task.exitCode ?? "unknown"}`;
  return `${task.id} ${task.state}${status} ${task.description}`;
}

function formatTaskWithOutput(task: TaskSnapshot) {
  const error = task.error ? `\nError: ${task.error}` : "";
  const output = task.outputTail
    ? `\n\nOutput${task.outputTruncated ? " tail" : ""}:\n${task.outputTail}`
    : "";
  return `${formatTask(task)}\nCommand: ${task.command}\nOutput file: ${task.outputPath}${error}${output}`;
}

function parseRequest(params: Record<string, unknown>): BackgroundCommandRequest {
  const request: BackgroundCommandRequest = {
    command: requiredString(params, "command"),
    description: requiredString(params, "description"),
    ...(params.cwd === undefined ? {} : { cwd: requiredString(params, "cwd") }),
    ...(params.timeout === undefined
      ? {}
      : { timeout: optionalBoundedNumber(params, "timeout", 0, 36_000_000)! }),
  };
  assertSafeBackgroundRequest(request);
  return request;
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
