import {
  Deferred,
  Effect,
  Option,
  Result,
} from "effect";

import { BoundedTaskOutput } from "./output.ts";
import { spawnTaskProcess } from "./subprocess.ts";
import type { TaskProcessResult } from "./subprocess.ts";
import {
  backgroundTaskFailure,
  type BackgroundCommandRequest,
  type StartBackgroundCommand,
  type TaskTerminalResult,
} from "./types.ts";

const DEFAULT_READY_TIMEOUT_MS = 30_000;

type StopReason = "cancelled" | "timed_out";
type ProcessOutcome =
  | { readonly _tag: "natural"; readonly result: TaskProcessResult }
  | { readonly _tag: "stop"; readonly reason: StopReason };

export const startBackgroundCommand: StartBackgroundCommand = Effect.fn(
  "agentos.backgroundTasks.command.start",
)(function*(request, context) {
  yield* assertSafeBackgroundRequest(request);
  const output = yield* BoundedTaskOutput.open(context.outputPath, {
    tailBytes: context.tailBytes,
    maxBytes: context.maxOutputBytes,
  }).pipe(
    Effect.mapError((cause) =>
      backgroundTaskFailure(
        "io_failure",
        `Failed to open background command output: ${cause.message}`,
        cause,
      )
    ),
  );
  const child = yield* spawnTaskProcess(request.command, {
    output,
    cwd: request.cwd,
    terminateGraceMs: context.terminateGraceMs,
    readyOutput: request.readyOutput,
  }).pipe(
    Effect.mapError((cause) =>
      backgroundTaskFailure(
        "runtime_failure",
        cause.message,
        cause,
      )
    ),
    Effect.tapError(() => output.close.pipe(Effect.ignore)),
  );
  const stopRequest = yield* Deferred.make<StopReason>();
  const terminal = yield* Deferred.make<TaskTerminalResult>();

  const timeoutRequest = request.timeout !== undefined && request.timeout > 0
    ? Effect.sleep(request.timeout).pipe(Effect.as<StopReason>("timed_out"))
    : Effect.never;
  const requestedStop = Effect.raceFirst(
    Deferred.await(stopRequest),
    Effect.raceFirst(
      context.cancellation.pipe(Effect.as<StopReason>("cancelled")),
      timeoutRequest,
    ),
  );
  const supervise = Effect.raceFirst(
    child.completion.pipe(
      Effect.map((result): ProcessOutcome => ({ _tag: "natural", result })),
    ),
    requestedStop.pipe(
      Effect.map((reason): ProcessOutcome => ({ _tag: "stop", reason })),
    ),
  ).pipe(
    Effect.flatMap((outcome) => {
      if (outcome._tag === "natural") {
        return Effect.succeed(toTerminalResult(outcome.result));
      }
      return child.stop().pipe(
        Effect.result,
        Effect.flatMap((stopped) =>
          Result.isSuccess(stopped)
            ? Effect.succeed(toTerminalResult(
                stopped.success,
                outcome.reason,
                request.timeout,
              ))
            : Effect.succeed<TaskTerminalResult>({
                state: "failed",
                summary: "Background command failed to stop",
                error: stopped.failure.message,
              })
        ),
      );
    }),
    Effect.flatMap((result) => Deferred.succeed(terminal, result)),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* supervise;

  const stop = () =>
    Deferred.succeed(stopRequest, "cancelled").pipe(
      Effect.andThen(Deferred.await(terminal)),
    );
  const handle = {
    completion: Deferred.await(terminal),
    processId: child.pid,
    stop,
  };

  if (request.readyOutput !== undefined) {
    const readyTimeout = request.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;
    const readiness = yield* child.readiness.pipe(
      Effect.timeoutOption(readyTimeout),
    );
    if (Option.isNone(readiness)) {
      yield* stop();
      return yield* Effect.fail(backgroundTaskFailure(
        "readiness_timeout",
        `Background command did not produce readiness output ${JSON.stringify(request.readyOutput)} within ${readyTimeout}ms`,
      ));
    }
    if (!readiness.value) {
      yield* Deferred.await(terminal);
      return yield* Effect.fail(backgroundTaskFailure(
        "readiness_exited",
        `Background command exited before producing readiness output ${JSON.stringify(request.readyOutput)}`,
      ));
    }
  }

  return handle;
});

export function assertSafeBackgroundRequest(request: BackgroundCommandRequest) {
  if (!request.command.trim()) {
    return invalidRequest("command must be a non-empty string");
  }
  if (!request.description.trim()) {
    return invalidRequest("description must be a non-empty string");
  }
  if (request.readyOutput !== undefined && request.readyOutput.length === 0) {
    return invalidRequest("ready_output must be a non-empty string");
  }
  if (request.readyTimeout !== undefined && request.readyOutput === undefined) {
    return invalidRequest("ready_timeout requires ready_output");
  }
  return Effect.void;
}

function invalidRequest(message: string) {
  return Effect.fail(backgroundTaskFailure("invalid_request", message));
}

function toTerminalResult(
  result: TaskProcessResult,
  stopReason?: StopReason,
  timeoutMillis?: number,
): TaskTerminalResult {
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
      error: `Command exceeded ${timeoutMillis ?? "its configured deadline"}ms`,
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
  if (result.error !== undefined) {
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
    error: result.signal !== null
      ? `Command terminated by ${result.signal}`
      : `Command exited with status ${result.exitCode ?? "unknown"}`,
  };
}
