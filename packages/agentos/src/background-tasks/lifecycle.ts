import { Option, Schema } from "effect";

import {
  TaskSignalSchema,
  type CompletionDelivery,
  type TaskSnapshot,
} from "./types.ts";

export const TASK_LIFECYCLE_ENTRY =
  "agentos-background-command-lifecycle";

const TaskId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  ),
);
const Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
      expected: "an ISO timestamp",
    }),
  ),
);
const NonNegativeFiniteNumber = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
);
const TaskStateSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
const CompletionDeliverySchema = Schema.Literals(["steer", "followUp"]);
const PersistedTaskSchema = Schema.Struct({
  id: TaskId,
  command: Schema.String,
  description: Schema.String,
  cwd: Schema.optional(Schema.String),
  state: TaskStateSchema,
  createdAt: Timestamp,
  startedAt: Timestamp,
  finishedAt: Schema.optional(Timestamp),
  durationMs: Schema.optional(NonNegativeFiniteNumber),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  signal: Schema.optional(Schema.NullOr(TaskSignalSchema)),
  error: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  completionDelivery: Schema.optional(CompletionDeliverySchema),
  completionObserved: Schema.Boolean,
  explicitlyKilled: Schema.Boolean,
});
const TaskLifecycleEntrySchema = Schema.Struct({
  version: Schema.Literal(1),
  task: PersistedTaskSchema,
});
const SessionLifecycleEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal(TASK_LIFECYCLE_ENTRY),
  data: TaskLifecycleEntrySchema,
});

type PersistedTask = typeof PersistedTaskSchema.Type;
export type TaskLifecycleEntry = typeof TaskLifecycleEntrySchema.Type;

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
      ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
      ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.signal === undefined ? {} : { signal: task.signal }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.summary === undefined ? {} : { summary: task.summary }),
      completionDelivery: task.completionDelivery,
      completionObserved: task.completionObserved,
      explicitlyKilled: task.explicitlyKilled,
    },
  };
}

export function restoreTaskLifecycle(entries: readonly unknown[]) {
  const latest = new Map<string, TaskSnapshot>();

  for (const entry of entries) {
    const decoded = Schema.decodeUnknownOption(SessionLifecycleEntrySchema)(
      entry,
    );
    if (Option.isNone(decoded)) continue;
    const snapshot = restoredSnapshot(decoded.value.data.task);
    latest.set(snapshot.id, snapshot);
  }

  const interrupted: TaskSnapshot[] = [];
  const tasks = [...latest.values()].map((task) => {
    const restored = cloneSnapshot(task);
    restored.completionObserved = true;
    if (
      restored.state === "running" ||
      (restored.state === "cancelled" && !restored.explicitlyKilled)
    ) {
      restored.state = "interrupted";
      restored.summary = "Background command interrupted by Pi runtime restart";
      interrupted.push(cloneSnapshot(restored));
    }
    return restored;
  });

  return { tasks, interrupted };
}

function restoredSnapshot(task: PersistedTask): TaskSnapshot {
  return {
    id: task.id,
    command: task.command,
    description: task.description,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    state: task.state,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    outputPath: "",
    outputTail: "",
    outputTruncated: false,
    outputBytes: 0,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    completionDelivery: task.completionDelivery ?? defaultCompletionDelivery(),
    completionObserved: task.completionObserved,
    explicitlyKilled: task.explicitlyKilled,
  };
}

function defaultCompletionDelivery(): CompletionDelivery {
  return "followUp";
}

function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot };
}
