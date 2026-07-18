import {
  BoundedTaskOutput,
  TaskOutputLimitError,
} from "./output.ts";

export type TaskProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  outputLimitReached: boolean;
};

export type TaskProcessHandle = {
  readonly pid: number;
  readonly completion: Promise<TaskProcessResult>;
  stop(): Promise<TaskProcessResult>;
};

export type TaskProcessOptions = {
  output: BoundedTaskOutput;
  cwd?: string;
  env?: Record<string, string | undefined>;
  terminateGraceMs?: number;
};

export function spawnTaskProcess(
  command: string,
  options: TaskProcessOptions,
): TaskProcessHandle {
  if (!command.trim()) throw new Error("Background command must not be empty");

  const shell =
    process.platform === "win32"
      ? process.env.ComSpec ?? "cmd.exe"
      : process.env.SHELL ?? "/bin/sh";
  const shellArguments =
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const child = Bun.spawn({
    cmd: [shell, ...shellArguments],
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  let settled = false;
  let resolveCompletion!: (result: TaskProcessResult) => void;
  let stopPromise: Promise<TaskProcessResult> | undefined;
  let outputLimitReached = false;

  const completion = new Promise<TaskProcessResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        try {
          await options.output.write(value);
        } catch (error) {
          if (!(error instanceof TaskOutputLimitError)) throw error;
          outputLimitReached = true;
          void stop();
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  const stdout = consume(child.stdout);
  const stderr = consume(child.stderr);

  const finalize = async (
    result: Omit<TaskProcessResult, "outputLimitReached">,
  ) => {
    if (settled) return;
    settled = true;
    await Promise.allSettled([stdout, stderr]);
    await options.output.close();
    resolveCompletion({ ...result, outputLimitReached });
  };

  void child.exited.then(
    (exitCode) => {
      const signal = child.signalCode;
      void finalize({ exitCode: signal ? null : exitCode, signal });
    },
    (error: unknown) => {
      void finalize({
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );

  function sendSignal(signal: NodeJS.Signals) {
    if (settled) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code === "EPERM") {
        child.kill(signal);
        return;
      }
      throw error;
    }
  }

  function stop(): Promise<TaskProcessResult> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (settled) return completion;
      sendSignal("SIGTERM");
      await Promise.race([completion, Bun.sleep(terminateGraceMs)]);
      if (!settled) sendSignal("SIGKILL");
      return completion;
    })();
    return stopPromise;
  }

  return {
    pid: child.pid,
    completion,
    stop,
  };
}
