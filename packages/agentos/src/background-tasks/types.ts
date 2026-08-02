import type {
  Effect,
  FileSystem,
  Path,
  Scope,
} from "effect";
import { Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export type CompletionDelivery = "steer" | "followUp";

export type BackgroundCommandRequest = {
  readonly command: string;
  readonly description: string;
  readonly cwd?: string;
  readonly timeout?: number;
  readonly readyOutput?: string;
  readonly readyTimeout?: number;
  readonly completionDelivery?: CompletionDelivery;
};

export type TaskState =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export const TaskSignalSchema = Schema.Literals([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE",
  "SIGHUP", "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL",
  "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV",
  "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1", "SIGUSR2",
  "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGLOST",
  "SIGINFO",
]);
export type TaskSignal = typeof TaskSignalSchema.Type;

export type TaskTerminalResult = {
  readonly state: Exclude<TaskState, "running">;
  readonly summary: string;
  readonly exitCode?: number | null;
  readonly signal?: TaskSignal | null;
  readonly error?: string;
};

export type TaskSnapshot = {
  id: string;
  command: string;
  description: string;
  cwd?: string;
  state: TaskState;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  outputPath: string;
  outputTail: string;
  outputTruncated: boolean;
  outputBytes: number;
  processId?: number;
  exitCode?: number | null;
  signal?: TaskSignal | null;
  error?: string;
  summary?: string;
  completionDelivery: CompletionDelivery;
  completionObserved: boolean;
  explicitlyKilled: boolean;
};

export type TaskEvent = {
  readonly type: "task_started" | "task_terminal";
  readonly task: TaskSnapshot;
};

export type TaskHandle = {
  readonly processId?: number;
  readonly completion: Effect.Effect<TaskTerminalResult>;
  readonly stop: () => Effect.Effect<TaskTerminalResult>;
};

export type TaskContext = {
  readonly outputPath: string;
  readonly tailBytes: number;
  readonly maxOutputBytes: number;
  readonly terminateGraceMs: number;
  readonly cancellation: Effect.Effect<void>;
};

const BackgroundTaskErrorCode = Schema.Literals([
  "broker_shutting_down",
  "duplicate_task",
  "invalid_request",
  "io_failure",
  "readiness_exited",
  "readiness_timeout",
  "restore_conflict",
  "runtime_failure",
  "unknown_task",
]);

export class BackgroundTaskError extends Schema.TaggedErrorClass<BackgroundTaskError>()(
  "BackgroundTaskError",
  {
    cause: Schema.Unknown,
    code: BackgroundTaskErrorCode,
    message: Schema.String,
  },
) {}

export type BackgroundTaskRuntime =
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

export type StartBackgroundCommand = (
  request: BackgroundCommandRequest,
  context: TaskContext,
) => Effect.Effect<TaskHandle, BackgroundTaskError, BackgroundTaskRuntime>;

export function backgroundTaskFailure(
  code: BackgroundTaskError["code"],
  message: string,
  cause: unknown = message,
) {
  return BackgroundTaskError.make({ cause, code, message });
}
