import {
  Deferred,
  Effect,
  Fiber,
  Option,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { BoundedTaskOutput } from "./output.ts";

export type TaskProcessResult = {
  readonly exitCode: number | null;
  readonly signal: ChildProcess.Signal | null;
  readonly error?: string;
  readonly outputLimitReached: boolean;
};

export type TaskProcessHandle = {
  readonly pid: number;
  readonly readiness: Effect.Effect<boolean>;
  readonly completion: Effect.Effect<TaskProcessResult>;
  readonly stop: () => Effect.Effect<TaskProcessResult, TaskProcessError>;
};

export type TaskProcessOptions = {
  readonly output: BoundedTaskOutput;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly terminateGraceMs?: number;
  readonly readyOutput?: string;
};

const TaskProcessErrorCode = Schema.Literals([
  "invalid_command",
  "invalid_readiness",
  "stop_failed",
]);

export class TaskProcessError extends Schema.TaggedErrorClass<TaskProcessError>()(
  "TaskProcessError",
  {
    cause: Schema.Unknown,
    code: TaskProcessErrorCode,
    message: Schema.String,
  },
) {}

export const spawnTaskProcess = Effect.fn(
  "agentos.backgroundTasks.subprocess.spawn",
)(function*(
  command: string,
  options: TaskProcessOptions,
): Effect.fn.Return<
  TaskProcessHandle,
  TaskProcessError,
  ChildProcessSpawner | Scope.Scope
> {
  if (!command.trim()) {
    return yield* processFailure(
      "invalid_command",
      "Background command must not be empty",
    );
  }
  if (options.readyOutput !== undefined && options.readyOutput.length === 0) {
    return yield* processFailure(
      "invalid_readiness",
      "Readiness output must not be empty",
    );
  }

  const readyMarker = options.readyOutput === undefined
    ? undefined
    : new TextEncoder().encode(options.readyOutput);
  const readiness = yield* Deferred.make<boolean>();
  if (readyMarker === undefined) yield* Deferred.succeed(readiness, true);
  const completion = yield* Deferred.make<TaskProcessResult>();
  const readinessTail = yield* Ref.make<Uint8Array>(new Uint8Array());
  const outputLimitReached = yield* Ref.make(false);
  const consumptionError = yield* Ref.make(Option.none<string>());
  const stopLock = yield* Semaphore.make(1);

  const child = yield* ChildProcess.make(command, {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...options.env },
    extendEnv: options.env !== undefined,
    shell: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }).pipe(
    Effect.mapError((cause) =>
      TaskProcessError.make({
        cause,
        code: "invalid_command",
        message: `Failed to start background command: ${cause.message}`,
      })
    ),
  );

  const killAfterOutputFailure = (message: string, limitReached: boolean) =>
    Effect.gen(function*() {
      if (limitReached) yield* Ref.set(outputLimitReached, true);
      else yield* Ref.set(consumptionError, Option.some(message));
      yield* child.kill({
        killSignal: "SIGTERM",
        forceKillAfter: options.terminateGraceMs ?? 2_000,
      }).pipe(Effect.ignore);
    });

  const consume = child.all.pipe(
    Stream.runForEach((chunk) =>
      options.output.write(chunk).pipe(
        Effect.tap(() => observeReadiness(chunk, readyMarker, readinessTail, readiness)),
        Effect.catchTag("TaskOutputError", (error) =>
          killAfterOutputFailure(
            error.message,
            error.code === "output_limit_reached",
          )
        ),
      )),
    Effect.catch((cause) =>
      killAfterOutputFailure(
        cause instanceof Error ? cause.message : String(cause),
        false,
      )
    ),
  );
  const consumerFiber = yield* consume.pipe(
    Effect.forkScoped({ startImmediately: true }),
  );

  const supervise = Effect.gen(function*() {
    const exit = yield* Effect.result(child.exitCode);
    yield* Fiber.join(consumerFiber).pipe(Effect.ignore);
    yield* Deferred.succeed(readiness, false);
    const close = yield* Effect.result(options.output.close);
    const storedConsumptionError = Option.getOrUndefined(
      yield* Ref.get(consumptionError),
    );
    const signal = Result.isFailure(exit)
      ? signalFromFailure(exit.failure)
      : null;
    const closeError = Result.isFailure(close) ? close.failure.message : undefined;
    const exitError = Result.isFailure(exit) && signal === null
      ? exit.failure.message
      : undefined;
    const error = storedConsumptionError ?? closeError ?? exitError;
    yield* Deferred.succeed(completion, {
      exitCode: Result.isSuccess(exit) ? Number(exit.success) : null,
      signal,
      ...(error === undefined ? {} : { error }),
      outputLimitReached: yield* Ref.get(outputLimitReached),
    });
  });
  yield* supervise.pipe(Effect.forkScoped({ startImmediately: true }));

  const stop = () => stopLock.withPermit(Effect.gen(function*() {
    const completed = Option.getOrUndefined(yield* Deferred.poll(completion));
    if (completed !== undefined) return yield* completed;
    const killed = yield* Effect.result(child.kill({
      killSignal: "SIGTERM",
      forceKillAfter: options.terminateGraceMs ?? 2_000,
    }));
    if (Result.isFailure(killed)) {
      const racedCompletion = Option.getOrUndefined(
        yield* Deferred.poll(completion),
      );
      if (racedCompletion !== undefined) return yield* racedCompletion;
      return yield* processFailure(
        "stop_failed",
        `Failed to stop background command: ${killed.failure.message}`,
        killed.failure,
      );
    }
    return yield* Deferred.await(completion);
  }));

  return {
    pid: Number(child.pid),
    readiness: Deferred.await(readiness),
    completion: Deferred.await(completion),
    stop,
  } satisfies TaskProcessHandle;
});

function observeReadiness(
  chunk: Uint8Array,
  marker: Uint8Array | undefined,
  tail: Ref.Ref<Uint8Array>,
  readiness: Deferred.Deferred<boolean>,
) {
  if (marker === undefined) return Effect.void;
  return Effect.gen(function*() {
    const previous = yield* Ref.get(tail);
    const candidate = concatenate(previous, chunk);
    if (contains(candidate, marker)) {
      yield* Deferred.succeed(readiness, true);
      return;
    }
    const retained = Math.max(0, marker.length - 1);
    yield* Ref.set(
      tail,
      candidate.slice(Math.max(0, candidate.length - retained)),
    );
  });
}

function concatenate(left: Uint8Array, right: Uint8Array) {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function contains(candidate: Uint8Array, marker: Uint8Array) {
  if (marker.length === 0) return true;
  for (let offset = 0; offset <= candidate.length - marker.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < marker.length; index += 1) {
      if (candidate[offset + index] !== marker[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function signalFromFailure(error: unknown): ChildProcess.Signal | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /signal: '([A-Z0-9]+)'/.exec(message);
  const value = match?.[1];
  if (isProcessSignal(value)) return value;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return signalFromFailure(error.cause);
  }
  return null;
}

function isProcessSignal(value: string | undefined): value is ChildProcess.Signal {
  return value !== undefined && PROCESS_SIGNALS.has(value);
}

const PROCESS_SIGNALS: ReadonlySet<string> = new Set([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE",
  "SIGHUP", "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL",
  "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV",
  "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1", "SIGUSR2",
  "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGLOST",
  "SIGINFO",
]);

function processFailure(
  code: TaskProcessError["code"],
  message: string,
  cause: unknown = message,
) {
  return Effect.fail(TaskProcessError.make({ cause, code, message }));
}
