import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

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
  const child = spawn(shell, shellArguments, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  let settled = false;
  let resolveCompletion!: (result: TaskProcessResult) => void;
  let stopPromise: Promise<TaskProcessResult> | undefined;
  let outputLimitReached = false;

  const completion = new Promise<TaskProcessResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const consume = async (stream: Readable) => {
    for await (const chunk of stream) {
      try {
        await options.output.write(Buffer.from(chunk));
      } catch (error) {
        if (!(error instanceof TaskOutputLimitError)) throw error;
        outputLimitReached = true;
        void stop();
        return;
      }
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

  child.once("close", (exitCode, signal) => {
    void finalize({ exitCode: signal ? null : exitCode, signal });
  });
  child.once("error", (error) => {
    void finalize({ exitCode: null, signal: null, error: error.message });
  });

  function sendSignal(signal: NodeJS.Signals) {
    if (settled) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
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
      await Promise.race([completion, sleep(terminateGraceMs)]);
      if (!settled) sendSignal("SIGKILL");
      return completion;
    })();
    return stopPromise;
  }

  return {
    pid: child.pid ?? 0,
    completion,
    stop,
  };
}
