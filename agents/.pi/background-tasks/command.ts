import { BoundedTaskOutput } from "./output.ts";
import { spawnTaskProcess } from "./subprocess.ts";
import type {
  BackgroundCommandRequest,
  StartBackgroundCommand,
  TaskHandle,
  TaskTerminalResult,
} from "./types.ts";

export const startBackgroundCommand: StartBackgroundCommand = async (
  request,
  context,
): Promise<TaskHandle> => {
  const output = await BoundedTaskOutput.open(context.outputPath, {
    tailBytes: context.tailBytes,
    maxBytes: context.maxOutputBytes,
  });
  let child: ReturnType<typeof spawnTaskProcess>;
  try {
    child = spawnTaskProcess(request.command, {
      output,
      cwd: request.cwd,
      env: globalThis.process.env,
      terminateGraceMs: context.terminateGraceMs,
    });
  } catch (error) {
    await output.close();
    throw error;
  }
  let stopReason: "cancelled" | "timed_out" | undefined;
  let stopPromise: Promise<TaskTerminalResult> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const completion = child.completion.then((result): TaskTerminalResult => {
    if (timeout) clearTimeout(timeout);
    context.signal.removeEventListener("abort", cancel);
    if (stopReason === "cancelled") {
      return {
        state: "cancelled",
        summary: "Background command killed",
        exitCode: result.exitCode,
        signal: result.signal,
      };
    }
    if (stopReason === "timed_out") {
      return {
        state: "failed",
        summary: "Background command timed out",
        error: `Command exceeded ${request.timeout}ms`,
        exitCode: result.exitCode,
        signal: result.signal,
      };
    }
    if (result.outputLimitReached) {
      return {
        state: "failed",
        summary: "Background command output limit reached",
        error: "Command output limit reached",
        exitCode: result.exitCode,
        signal: result.signal,
      };
    }
    if (result.error) {
      return {
        state: "failed",
        summary: "Background command failed",
        error: result.error,
        exitCode: result.exitCode,
        signal: result.signal,
      };
    }
    if (result.exitCode === 0) {
      return {
        state: "succeeded",
        summary: "Background command completed",
        exitCode: 0,
        signal: result.signal,
      };
    }
    return {
      state: "failed",
      summary: "Background command failed",
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.signal
        ? `Command terminated by ${result.signal}`
        : `Command exited with status ${result.exitCode ?? "unknown"}`,
    };
  });

  function stop(reason: "cancelled" | "timed_out") {
    stopReason ??= reason;
    if (stopPromise) return stopPromise;
    const stopping = child.stop().then(() => completion);
    stopPromise = stopping;
    return stopping;
  }

  function cancel() {
    void stop("cancelled");
  }

  context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  if (request.timeout !== undefined && request.timeout > 0) {
    timeout = setTimeout(() => void stop("timed_out"), request.timeout);
  }

  return {
    completion,
    stop: () => stop("cancelled"),
  };
};

export function assertSafeBackgroundRequest(request: BackgroundCommandRequest) {
  if (!request.command.trim()) throw new Error("command must be a non-empty string");
  if (!request.description.trim()) {
    throw new Error("description must be a non-empty string");
  }
}
