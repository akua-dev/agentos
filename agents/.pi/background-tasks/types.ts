export type BackgroundCommandRequest = {
  command: string;
  description: string;
  cwd?: string;
  timeout?: number;
  readyOutput?: string;
  readyTimeout?: number;
};

export type TaskState =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export type TaskTerminalResult = {
  state: Exclude<TaskState, "running">;
  summary: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
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
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  summary?: string;
  completionObserved: boolean;
  explicitlyKilled: boolean;
};

export type TaskEvent = {
  type: "task_started" | "task_terminal";
  task: TaskSnapshot;
};

export type TaskHandle = {
  completion: Promise<TaskTerminalResult>;
  stop(): Promise<TaskTerminalResult>;
};

export type TaskContext = {
  outputPath: string;
  tailBytes: number;
  maxOutputBytes: number;
  terminateGraceMs: number;
  signal: AbortSignal;
};

export type StartBackgroundCommand = (
  request: BackgroundCommandRequest,
  context: TaskContext,
) => Promise<TaskHandle>;
