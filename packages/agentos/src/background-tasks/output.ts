import {
  Effect,
  Exit,
  FileSystem,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";

const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

const TaskOutputErrorCode = Schema.Literals([
  "closed",
  "invalid_limits",
  "io_failure",
  "output_limit_reached",
]);

export class TaskOutputError extends Schema.TaggedErrorClass<TaskOutputError>()(
  "TaskOutputError",
  {
    cause: Schema.Unknown,
    code: TaskOutputErrorCode,
    message: Schema.String,
    path: Schema.String,
  },
) {}

export interface TaskOutputSnapshot {
  readonly bytesWritten: number;
  readonly tail: string;
  readonly truncated: boolean;
  readonly limitReached: boolean;
}

export interface BoundedTaskOutput {
  readonly path: string;
  readonly write: (chunk: Uint8Array) => Effect.Effect<void, TaskOutputError>;
  readonly snapshot: Effect.Effect<TaskOutputSnapshot>;
  readonly close: Effect.Effect<void, TaskOutputError>;
}

interface OutputState {
  readonly bytesWritten: number;
  readonly closed: boolean;
  readonly limitReached: boolean;
  readonly tail: Uint8Array;
  readonly truncated: boolean;
}

export const BoundedTaskOutput = {
  open: Effect.fn("agentos.backgroundTasks.output.open")(function*(
    path: string,
    options: { readonly tailBytes?: number; readonly maxBytes?: number } = {},
  ) {
    const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (tailBytes < 0 || maxBytes <= 0) {
      return yield* outputFailure(
        "invalid_limits",
        path,
        "Output limits must be positive",
      );
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fileSystem.makeDirectory(paths.dirname(path), {
      recursive: true,
      mode: 0o700,
    }).pipe(Effect.mapError(mapIo(path, "create output directory")));

    const fileScope = yield* Scope.make();
    const file = yield* fileSystem.open(path, {
      flag: "w",
      mode: 0o600,
    }).pipe(
      Effect.provideService(Scope.Scope, fileScope),
      Effect.mapError(mapIo(path, "open output")),
    );
    const lock = yield* Semaphore.make(1);
    const state = yield* Ref.make<OutputState>({
      bytesWritten: 0,
      closed: false,
      limitReached: false,
      tail: new Uint8Array(),
      truncated: false,
    });

    const write = (chunk: Uint8Array) =>
      lock.withPermit(Effect.gen(function*() {
        const current = yield* Ref.get(state);
        if (current.closed) {
          return yield* outputFailure(
            "closed",
            path,
            "Background task output is closed",
          );
        }
        const remaining = Math.max(0, maxBytes - current.bytesWritten);
        const accepted = chunk.subarray(0, remaining);
        if (accepted.length > 0) {
          yield* file.writeAll(accepted).pipe(
            Effect.mapError(mapIo(path, "write output")),
          );
        }
        const bytesWritten = current.bytesWritten + accepted.length;
        const nextTail = appendTail(current.tail, accepted, tailBytes);
        const overflowed = accepted.length !== chunk.length;
        yield* Ref.set(state, {
          bytesWritten,
          closed: false,
          limitReached: current.limitReached || overflowed,
          tail: nextTail,
          truncated: current.truncated || bytesWritten > nextTail.length,
        });
        if (overflowed) {
          return yield* outputFailure(
            "output_limit_reached",
            path,
            `Background task output reached the ${maxBytes}-byte limit`,
          );
        }
      }));

    const snapshot = Ref.get(state).pipe(
      Effect.map((current): TaskOutputSnapshot => ({
        bytesWritten: current.bytesWritten,
        tail: new TextDecoder().decode(current.tail),
        truncated: current.truncated,
        limitReached: current.limitReached,
      })),
    );

    const close = lock.withPermit(Effect.gen(function*() {
      const current = yield* Ref.get(state);
      if (current.closed) return;
      yield* Ref.set(state, { ...current, closed: true });
      yield* file.sync.pipe(Effect.mapError(mapIo(path, "sync output")));
      yield* Scope.close(fileScope, Exit.void);
    }));

    return { path, write, snapshot, close } satisfies BoundedTaskOutput;
  }),
};

function appendTail(
  previous: Uint8Array,
  chunk: Uint8Array,
  maximumBytes: number,
) {
  if (maximumBytes === 0) return new Uint8Array();
  const combined = new Uint8Array(previous.length + chunk.length);
  combined.set(previous);
  combined.set(chunk, previous.length);
  return combined.length <= maximumBytes
    ? combined
    : combined.slice(combined.length - maximumBytes);
}

function mapIo(path: string, operation: string) {
  return (cause: unknown) =>
    TaskOutputError.make({
      cause,
      code: "io_failure",
      message: `Failed to ${operation}`,
      path,
    });
}

function outputFailure(
  code: TaskOutputError["code"],
  path: string,
  message: string,
) {
  return Effect.fail(TaskOutputError.make({
    cause: message,
    code,
    message,
    path,
  }));
}
