import {
  Clock,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Result,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { startBackgroundCommand } from "./command.ts";
import {
  backgroundTaskFailure,
  type BackgroundCommandRequest,
  type BackgroundTaskError,
  type BackgroundTaskRuntime,
  type StartBackgroundCommand,
  type TaskEvent,
  type TaskHandle,
  type TaskSnapshot,
  type TaskTerminalResult,
} from "./types.ts";

type BrokerOptions = {
  readonly rootDirectory: string;
  readonly startCommand?: StartBackgroundCommand;
  readonly createId?: () => Effect.Effect<string, BackgroundTaskError>;
  readonly now?: () => Effect.Effect<Date>;
  readonly tailBytes?: number;
  readonly maxOutputBytes?: number;
  readonly terminateGraceMs?: number;
};

type TaskRecord = {
  readonly request: BackgroundCommandRequest;
  readonly snapshot: TaskSnapshot;
  readonly cancellation: Deferred.Deferred<void>;
  readonly terminal: Deferred.Deferred<void>;
  handle?: TaskHandle;
  blockingWaiters: number;
  suppressWake: boolean;
  stopStarted: boolean;
};

type EventListener = (event: TaskEvent) => Effect.Effect<void>;

export class BackgroundTaskBroker {
  static make = Effect.fn("agentos.backgroundTasks.broker.make")(function*(
    options: BrokerOptions,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const scope = yield* Scope.Scope;
    const runtime = yield* Effect.context<BackgroundTaskRuntime>();
    const lock = yield* Semaphore.make(1);
    const createId = options.createId ?? (() =>
      crypto.randomUUIDv4.pipe(
        Effect.map((id) => `bg-${id.replaceAll("-", "").slice(0, 12)}`),
        Effect.mapError((cause) =>
          backgroundTaskFailure(
            "runtime_failure",
            "Failed to create a background command ID",
            cause,
          )
        ),
      ));
    const now = options.now ?? (() =>
      Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis))));
    const start = options.startCommand ?? startBackgroundCommand;
    const runStart = (request: BackgroundCommandRequest, record: TaskRecord) =>
      start(request, {
        outputPath: record.snapshot.outputPath,
        tailBytes: options.tailBytes ?? 64 * 1024,
        maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024 * 1024,
        terminateGraceMs: options.terminateGraceMs ?? 2_000,
        cancellation: Deferred.await(record.cancellation),
      }).pipe(Effect.provide(runtime));

    return new BackgroundTaskBroker(
      options.rootDirectory,
      fileSystem,
      paths,
      scope,
      lock,
      createId,
      now,
      runStart,
      options.tailBytes ?? 64 * 1024,
    );
  });

  readonly #records = new Map<string, TaskRecord>();
  readonly #listeners = new Set<EventListener>();
  readonly #rootDirectory: string;
  readonly #fileSystem: FileSystem.FileSystem;
  readonly #paths: Path.Path;
  readonly #scope: Scope.Scope;
  readonly #lock: Semaphore.Semaphore;
  readonly #createId: () => Effect.Effect<string, BackgroundTaskError>;
  readonly #now: () => Effect.Effect<Date>;
  readonly #runStart: (
    request: BackgroundCommandRequest,
    record: TaskRecord,
  ) => Effect.Effect<TaskHandle, BackgroundTaskError>;
  readonly #tailBytes: number;
  #shuttingDown = false;

  private constructor(
    rootDirectory: string,
    fileSystem: FileSystem.FileSystem,
    paths: Path.Path,
    scope: Scope.Scope,
    lock: Semaphore.Semaphore,
    createId: () => Effect.Effect<string, BackgroundTaskError>,
    now: () => Effect.Effect<Date>,
    runStart: (
      request: BackgroundCommandRequest,
      record: TaskRecord,
    ) => Effect.Effect<TaskHandle, BackgroundTaskError>,
    tailBytes: number,
  ) {
    this.#rootDirectory = rootDirectory;
    this.#fileSystem = fileSystem;
    this.#paths = paths;
    this.#scope = scope;
    this.#lock = lock;
    this.#createId = createId;
    this.#now = now;
    this.#runStart = runStart;
    this.#tailBytes = tailBytes;
  }

  onEvent(listener: EventListener) {
    return Effect.sync(() => {
      this.#listeners.add(listener);
      return Effect.sync(() => {
        this.#listeners.delete(listener);
      });
    });
  }

  start(request: BackgroundCommandRequest) {
    return Effect.gen({ self: this }, function*() {
      const record = yield* this.#lock.withPermit(this.#createRecord(request));
      yield* this.#emit({
        type: "task_started",
        task: cloneSnapshot(record.snapshot),
      });

      const started = yield* Effect.result(this.#runStart(request, record));
      if (Result.isFailure(started)) {
        record.suppressWake = true;
        yield* this.#finalize(record, {
          state: "failed",
          summary: "Background command failed to start",
          error: started.failure.message,
        });
      } else {
        yield* this.#lock.withPermit(Effect.sync(() => {
          record.handle = started.success;
          if (started.success.processId !== undefined) {
            record.snapshot.processId = started.success.processId;
          }
        }));
        yield* started.success.completion.pipe(
          Effect.flatMap((result) => this.#finalize(record, result)),
          Effect.forkIn(this.#scope, { startImmediately: true }),
        );
      }
      return yield* this.get(record.snapshot.id);
    });
  }

  get(
    id: string,
    options: {
      readonly waitMs?: number;
      readonly outputBytes?: number;
      readonly observeCompletion?: boolean;
    } = {},
  ) {
    return Effect.gen({ self: this }, function*() {
      const record = yield* this.#requiredRecord(id);
      if (record.snapshot.state === "running" && (options.waitMs ?? 0) > 0) {
        yield* this.#lock.withPermit(Effect.sync(() => {
          record.blockingWaiters += 1;
        }));
        const completed = yield* Deferred.await(record.terminal).pipe(
          Effect.timeoutOption(options.waitMs ?? 0),
          Effect.ensuring(this.#lock.withPermit(Effect.sync(() => {
            record.blockingWaiters = Math.max(0, record.blockingWaiters - 1);
          }))),
        );
        if (Option.isSome(completed)) {
          yield* this.#lock.withPermit(Effect.sync(() => {
            record.snapshot.completionObserved = true;
          }));
        }
      }
      if (options.observeCompletion && record.snapshot.state !== "running") {
        yield* this.#lock.withPermit(Effect.sync(() => {
          record.snapshot.completionObserved = true;
        }));
      }
      yield* this.#refreshOutput(
        record,
        options.outputBytes ?? this.#tailBytes,
      );
      return yield* this.#lock.withPermit(
        Effect.sync(() => cloneSnapshot(record.snapshot)),
      );
    });
  }

  list() {
    return this.#lock.withPermit(Effect.sync(() =>
      [...this.#records.values()]
        .map(({ snapshot }) => ({
          ...cloneSnapshot(snapshot),
          outputTail: "",
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))));
  }

  getRequest(id: string) {
    return this.#requiredRecord(id).pipe(
      Effect.map((record) => ({ ...record.request })),
    );
  }

  restore(snapshots: readonly TaskSnapshot[]) {
    return this.#lock.withPermit(Effect.gen({ self: this }, function*() {
      if (this.#records.size > 0) {
        return yield* Effect.fail(backgroundTaskFailure(
          "restore_conflict",
          "Cannot restore background commands after this broker started",
        ));
      }
      for (const snapshot of snapshots) {
        if (snapshot.state === "running") {
          return yield* Effect.fail(backgroundTaskFailure(
            "restore_conflict",
            `Cannot restore running background command: ${snapshot.id}`,
          ));
        }
        if (this.#records.has(snapshot.id)) {
          return yield* Effect.fail(backgroundTaskFailure(
            "restore_conflict",
            `Duplicate restored background command: ${snapshot.id}`,
          ));
        }
        const restored = cloneSnapshot(snapshot);
        restored.outputPath = this.#paths.join(
          this.#rootDirectory,
          `${restored.id}.log`,
        );
        restored.outputTail = "";
        restored.outputTruncated = false;
        restored.outputBytes = 0;
        restored.completionObserved = true;
        this.#records.set(restored.id, {
          request: {
            command: restored.command,
            description: restored.description,
            ...(restored.cwd === undefined ? {} : { cwd: restored.cwd }),
            completionDelivery: restored.completionDelivery,
          },
          snapshot: restored,
          cancellation: yield* Deferred.make<void>(),
          terminal: yield* completedDeferred(),
          blockingWaiters: 0,
          suppressWake: true,
          stopStarted: true,
        });
      }
    }));
  }

  kill(id: string) {
    return Effect.gen({ self: this }, function*() {
      const record = yield* this.#requiredRecord(id);
      const shouldStop = yield* this.#lock.withPermit(Effect.sync(() => {
        record.snapshot.explicitlyKilled = true;
        record.snapshot.completionObserved = true;
        record.suppressWake = true;
        if (record.snapshot.state !== "running" || record.stopStarted) {
          return false;
        }
        record.stopStarted = true;
        return true;
      }));
      if (shouldStop) yield* this.#stopRecord(record, "Background command killed before start");
      else if (record.snapshot.state === "running") yield* Deferred.await(record.terminal);
      return yield* this.get(id);
    });
  }

  get shutdown() {
    return Effect.gen({ self: this }, function*() {
      const records = yield* this.#lock.withPermit(Effect.sync(() => {
        if (this.#shuttingDown) return [];
        this.#shuttingDown = true;
        return [...this.#records.values()].filter((record) => {
          if (record.snapshot.state !== "running" || record.stopStarted) {
            return false;
          }
          record.stopStarted = true;
          record.suppressWake = true;
          record.snapshot.completionObserved = true;
          return true;
        });
      }));
      yield* Effect.forEach(
        records,
        (record) =>
          this.#stopRecord(
            record,
            "Background command stopped during Pi shutdown",
          ),
        { concurrency: "unbounded", discard: true },
      );
    });
  }

  #createRecord(request: BackgroundCommandRequest) {
    return Effect.gen({ self: this }, function*() {
      if (this.#shuttingDown) {
        return yield* Effect.fail(backgroundTaskFailure(
          "broker_shutting_down",
          "Background command broker is shutting down",
        ));
      }
      const id = yield* this.#createId();
      if (this.#records.has(id)) {
        return yield* Effect.fail(backgroundTaskFailure(
          "duplicate_task",
          `Background command ${id} already exists`,
        ));
      }
      const createdAt = (yield* this.#now()).toISOString();
      const snapshot: TaskSnapshot = {
        id,
        command: request.command,
        description: request.description,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        state: "running",
        createdAt,
        startedAt: createdAt,
        outputPath: this.#paths.join(this.#rootDirectory, `${id}.log`),
        outputTail: "",
        outputTruncated: false,
        outputBytes: 0,
        completionDelivery: request.completionDelivery ?? "followUp",
        completionObserved: false,
        explicitlyKilled: false,
      };
      const record: TaskRecord = {
        request: { ...request },
        snapshot,
        cancellation: yield* Deferred.make<void>(),
        terminal: yield* Deferred.make<void>(),
        blockingWaiters: 0,
        suppressWake: false,
        stopStarted: false,
      };
      this.#records.set(id, record);
      return record;
    });
  }

  #finalize(record: TaskRecord, result: TaskTerminalResult) {
    return Effect.gen({ self: this }, function*() {
      yield* this.#refreshOutput(record, this.#tailBytes).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Background task output refresh failed", {
            taskId: record.snapshot.id,
            error: error.message,
          })
        ),
      );
      const event = yield* this.#lock.withPermit(Effect.gen({ self: this }, function*() {
        if (record.snapshot.state !== "running") return Option.none<TaskEvent>();
        const finished = yield* this.#now();
        record.snapshot.state = result.state;
        record.snapshot.finishedAt = finished.toISOString();
        record.snapshot.durationMs = Math.max(
          0,
          finished.getTime() - new Date(record.snapshot.startedAt).getTime(),
        );
        record.snapshot.summary = result.summary;
        record.snapshot.exitCode = result.exitCode;
        record.snapshot.signal = result.signal;
        record.snapshot.error = result.error;
        record.snapshot.completionObserved =
          record.suppressWake || record.blockingWaiters > 0;
        return Option.some<TaskEvent>({
          type: "task_terminal",
          task: cloneSnapshot(record.snapshot),
        });
      }));
      if (Option.isSome(event)) {
        yield* this.#emit(event.value).pipe(
          Effect.ensuring(Deferred.succeed(record.terminal, undefined)),
        );
      }
    });
  }

  #requiredRecord(id: string) {
    return this.#lock.withPermit(Effect.suspend(() => {
      const record = this.#records.get(id);
      return record === undefined
        ? Effect.fail(backgroundTaskFailure(
            "unknown_task",
            `Unknown background command: ${id}`,
          ))
        : Effect.succeed(record);
    }));
  }

  #refreshOutput(record: TaskRecord, maximumBytes: number) {
    return Effect.gen({ self: this }, function*() {
      const inspected = yield* Effect.result(
        this.#fileSystem.stat(record.snapshot.outputPath),
      );
      if (Result.isFailure(inspected)) {
        if (inspected.failure.reason._tag === "NotFound") return;
        return yield* Effect.fail(backgroundTaskFailure(
          "io_failure",
          `Failed to inspect background command output ${record.snapshot.outputPath}`,
          inspected.failure,
        ));
      }
      const fileBytes = Number(inspected.success.size);
      const bytes = Math.max(0, Math.min(maximumBytes, fileBytes));
      const chunks = bytes === 0
        ? []
        : yield* this.#fileSystem.stream(record.snapshot.outputPath, {
            offset: inspected.success.size - BigInt(bytes),
            bytesToRead: bytes,
          }).pipe(
            Stream.runCollect,
            Effect.mapError((cause) =>
              backgroundTaskFailure(
                "io_failure",
                `Failed to read background command output ${record.snapshot.outputPath}`,
                cause,
              )
            ),
          );
      const content = concatenate(chunks);
      yield* this.#lock.withPermit(Effect.sync(() => {
        record.snapshot.outputBytes = fileBytes;
        record.snapshot.outputTail = new TextDecoder().decode(content);
        record.snapshot.outputTruncated = fileBytes > bytes;
      }));
    });
  }

  #stopRecord(record: TaskRecord, beforeStartSummary: string) {
    return Effect.gen({ self: this }, function*() {
      yield* Deferred.succeed(record.cancellation, undefined);
      const result: TaskTerminalResult = record.handle === undefined
        ? {
            state: "cancelled",
            summary: beforeStartSummary,
          }
        : yield* record.handle.stop();
      yield* this.#finalize(record, result);
      yield* Deferred.await(record.terminal);
    });
  }

  #emit(event: TaskEvent) {
    return Effect.forEach(
      [...this.#listeners],
      (listener) => listener(event),
      { discard: true },
    );
  }
}

function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot };
}

function completedDeferred() {
  return Effect.gen(function*() {
    const deferred = yield* Deferred.make<void>();
    yield* Deferred.succeed(deferred, undefined);
    return deferred;
  });
}

function concatenate(chunks: ReadonlyArray<Uint8Array>) {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}
