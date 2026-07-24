import type { TaskSnapshot, TaskState } from "./types.ts";

export const TASK_LIFECYCLE_ENTRY =
  "agentos-background-command-lifecycle";

type PersistedTask = {
  id: string;
  command: string;
  description: string;
  cwd?: string;
  state: TaskState;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  summary?: string;
  completionObserved: boolean;
  explicitlyKilled: boolean;
};

export type TaskLifecycleEntry = {
  version: 1;
  task: PersistedTask;
};

export function taskLifecycleEntry(task: TaskSnapshot): TaskLifecycleEntry {
  return {
    version: 1,
    task: {
      id: task.id,
      command: task.command,
      description: task.description,
      ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
      state: task.state,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      ...(task.finishedAt === undefined
        ? {}
        : { finishedAt: task.finishedAt }),
      ...(task.durationMs === undefined
        ? {}
        : { durationMs: task.durationMs }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.signal === undefined ? {} : { signal: task.signal }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.summary === undefined ? {} : { summary: task.summary }),
      completionObserved: task.completionObserved,
      explicitlyKilled: task.explicitlyKilled,
    },
  };
}

export function restoreTaskLifecycle(entries: readonly unknown[]) {
  const latest = new Map<string, TaskSnapshot>();

  for (const entry of entries) {
    if (!isObject(entry)) continue;
    if (
      entry.type !== "custom" ||
      entry.customType !== TASK_LIFECYCLE_ENTRY
    ) {
      continue;
    }
    const snapshot = parseLifecycleData(entry.data);
    if (snapshot) latest.set(snapshot.id, snapshot);
  }

  const interrupted: TaskSnapshot[] = [];
  const tasks = [...latest.values()].map((task) => {
    const restored = structuredClone(task);
    restored.completionObserved = true;
    if (
      restored.state === "running" ||
      (restored.state === "cancelled" && !restored.explicitlyKilled)
    ) {
      restored.state = "interrupted";
      restored.summary = "Background command interrupted by Pi runtime restart";
      interrupted.push(structuredClone(restored));
    }
    return restored;
  });

  return { tasks, interrupted };
}

function parseLifecycleData(value: unknown): TaskSnapshot | undefined {
  if (!isObject(value) || value.version !== 1 || !isObject(value.task)) {
    return undefined;
  }
  const task = value.task;
  if (
    !safeTaskId(task.id) ||
    typeof task.command !== "string" ||
    typeof task.description !== "string" ||
    !taskState(task.state) ||
    !timestamp(task.createdAt) ||
    !timestamp(task.startedAt) ||
    typeof task.completionObserved !== "boolean" ||
    typeof task.explicitlyKilled !== "boolean"
  ) {
    return undefined;
  }
  if (task.cwd !== undefined && typeof task.cwd !== "string") return undefined;
  if (task.finishedAt !== undefined && !timestamp(task.finishedAt)) {
    return undefined;
  }
  if (
    task.durationMs !== undefined &&
    (!finiteNumber(task.durationMs) || task.durationMs < 0)
  ) {
    return undefined;
  }
  if (
    task.exitCode !== undefined &&
    task.exitCode !== null &&
    !finiteNumber(task.exitCode)
  ) {
    return undefined;
  }
  if (
    task.signal !== undefined &&
    task.signal !== null &&
    typeof task.signal !== "string"
  ) {
    return undefined;
  }
  if (task.error !== undefined && typeof task.error !== "string") {
    return undefined;
  }
  if (task.summary !== undefined && typeof task.summary !== "string") {
    return undefined;
  }

  return {
    id: task.id,
    command: task.command,
    description: task.description,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    state: task.state,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    ...(task.finishedAt === undefined
      ? {}
      : { finishedAt: task.finishedAt }),
    ...(task.durationMs === undefined
      ? {}
      : { durationMs: task.durationMs }),
    outputPath: "",
    outputTail: "",
    outputTruncated: false,
    outputBytes: 0,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.signal === undefined
      ? {}
      : { signal: task.signal as NodeJS.Signals | null }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    completionObserved: task.completionObserved,
    explicitlyKilled: task.explicitlyKilled,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  );
}

function taskState(value: unknown): value is TaskState {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  );
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
