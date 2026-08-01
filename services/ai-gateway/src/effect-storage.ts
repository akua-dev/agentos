import lockfile from "proper-lockfile";
import {
  Clock,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Path,
  Schema,
  Semaphore,
} from "effect";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MILLIS = 5_000;
const DEFAULT_MAXIMUM_BYTES = 4 * 1_024 * 1_024;

const AtomicJsonStoreErrorCode = Schema.Literals([
  "invalid_data",
  "lock_timeout",
  "storage_unavailable",
]);

export class AtomicJsonStoreError extends Schema.TaggedErrorClass<AtomicJsonStoreError>()(
  "AtomicJsonStoreError",
  { code: AtomicJsonStoreErrorCode },
) {}

export interface StoreInspection {
  readonly exists: boolean;
  readonly valid: boolean;
  readonly mode?: number;
}

export interface AtomicJsonStore<T> {
  readonly read: Effect.Effect<T, AtomicJsonStoreError>;
  readonly modify: <A, E, R>(
    mutator: (
      current: T,
    ) => Effect.Effect<readonly [result: A, state: T], E, R>,
  ) => Effect.Effect<A, AtomicJsonStoreError | E, R>;
  readonly update: <E, R>(
    mutator: (current: T) => Effect.Effect<T, E, R>,
  ) => Effect.Effect<T, AtomicJsonStoreError | E, R>;
  readonly inspect: Effect.Effect<StoreInspection, AtomicJsonStoreError>;
}

export interface AtomicJsonStoreOptions<T> {
  readonly path: string;
  readonly schema: Schema.Codec<T, unknown>;
  readonly createDefault: () => T;
  readonly lockTimeoutMillis?: number;
  readonly maximumBytes?: number;
}

export const makeAtomicJsonStore = Effect.fn(
  "agentos.aiGateway.makeAtomicJsonStore",
)(function*<T>(options: AtomicJsonStoreOptions<T>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const localLock = yield* Semaphore.make(1);
  const parent = paths.dirname(options.path);
  const lockTarget = `${options.path}.lock-target`;
  const lockTimeoutMillis = options.lockTimeoutMillis ??
    DEFAULT_LOCK_TIMEOUT_MILLIS;
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;

  const ensurePrivateParent = Effect.gen(function*() {
    yield* fileSystem.makeDirectory(parent, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    yield* fileSystem.chmod(parent, DIRECTORY_MODE);
  }).pipe(Effect.mapError(() => storeError("storage_unavailable")));

  const acquireLock = Effect.gen(function*() {
    yield* ensurePrivateParent;
    yield* fileSystem.writeFileString(lockTarget, "", {
      flag: "a",
      mode: FILE_MODE,
    }).pipe(Effect.mapError(() => storeError("storage_unavailable")));
    yield* fileSystem.chmod(lockTarget, FILE_MODE).pipe(
      Effect.mapError(() => storeError("storage_unavailable")),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + lockTimeoutMillis;

    const retry = (): Effect.Effect<
      () => Promise<void>,
      AtomicJsonStoreError
    > =>
      Effect.gen(function*() {
        const result = yield* Effect.tryPromise({
          try: () =>
            lockfile.lock(lockTarget, {
              realpath: false,
              stale: 30_000,
              update: 10_000,
            }),
          catch: (cause) =>
            storeError(
              isLockContention(cause)
                ? "lock_timeout"
                : "storage_unavailable",
            ),
        }).pipe(Effect.result);
        if (result._tag === "Success") return result.success;
        if (result.failure.code !== "lock_timeout") {
          return yield* result.failure;
        }
        const now = yield* Clock.currentTimeMillis;
        if (now >= deadline) return yield* result.failure;
        yield* Effect.sleep(Duration.millis(Math.min(10, deadline - now)));
        return yield* retry();
      });

    return yield* retry();
  });

  const releaseLock = (release: () => Promise<void>) =>
    Effect.tryPromise({
      try: () => release(),
      catch: () => storeError("storage_unavailable"),
    }).pipe(Effect.catchCause(() => Effect.void));

  const withLock = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    localLock.withPermit(
      Effect.acquireUseRelease(
        acquireLock,
        () => operation,
        releaseLock,
      ),
    );

  const decode = (source: string) =>
    Schema.decodeUnknownEffect(
      Schema.fromJsonString(options.schema),
    )(source).pipe(
      Effect.mapError(() => storeError("invalid_data")),
    );

  const readValidated = Effect.gen(function*() {
    const metadata = yield* fileSystem.stat(options.path).pipe(
      Effect.mapError(() => storeError("storage_unavailable")),
    );
    if (
      metadata.type !== "File" ||
      metadata.size > FileSystem.Size(maximumBytes)
    ) {
      return yield* storeError("invalid_data");
    }
    const source = yield* fileSystem.readFileString(options.path).pipe(
      Effect.mapError(() => storeError("storage_unavailable")),
    );
    return yield* decode(source);
  });

  const syncPath = (path: string) =>
    Effect.scoped(
      fileSystem.open(path, { flag: "r" }).pipe(
        Effect.flatMap((file) => file.sync),
      ),
    );

  const writeAtomic = (value: T) =>
    Effect.gen(function*() {
      const source = yield* Schema.encodeEffect(
        Schema.fromJsonString(options.schema),
      )(value).pipe(Effect.mapError(() => storeError("invalid_data")));
      if (new TextEncoder().encode(source).byteLength > maximumBytes) {
        return yield* storeError("invalid_data");
      }
      const identifier = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => storeError("storage_unavailable")),
      );
      const temporaryPath = `${options.path}.${identifier}.tmp`;
      yield* Effect.gen(function*() {
        yield* fileSystem.writeFileString(
          temporaryPath,
          `${source}\n`,
          { flag: "wx", mode: FILE_MODE },
        );
        yield* fileSystem.chmod(temporaryPath, FILE_MODE);
        yield* syncPath(temporaryPath);
        yield* fileSystem.rename(temporaryPath, options.path);
        yield* fileSystem.chmod(options.path, FILE_MODE);
        yield* syncPath(parent).pipe(Effect.ignore);
      }).pipe(
        Effect.mapError(() => storeError("storage_unavailable")),
        Effect.ensuring(
          fileSystem.remove(temporaryPath, { force: true }).pipe(
            Effect.ignore,
          ),
        ),
      );
    });

  const readOrCreate = Effect.gen(function*() {
    yield* ensurePrivateParent;
    const exists = yield* fileSystem.exists(options.path).pipe(
      Effect.mapError(() => storeError("storage_unavailable")),
    );
    if (exists) {
      yield* fileSystem.chmod(options.path, FILE_MODE).pipe(
        Effect.mapError(() => storeError("storage_unavailable")),
      );
      return yield* readValidated;
    }
    const initial = yield* Schema.decodeUnknownEffect(options.schema)(
      options.createDefault(),
    ).pipe(Effect.mapError(() => storeError("invalid_data")));
    yield* writeAtomic(initial);
    return initial;
  });

  return {
    read: withLock(readOrCreate),
    modify: (mutator) =>
      withLock(Effect.gen(function*() {
        const current = yield* readOrCreate;
        const [result, proposed] = yield* mutator(current);
        const next = yield* Schema.decodeUnknownEffect(options.schema)(
          proposed,
        ).pipe(Effect.mapError(() => storeError("invalid_data")));
        yield* writeAtomic(next);
        return result;
      })),
    update: (mutator) =>
      withLock(Effect.gen(function*() {
        const current = yield* readOrCreate;
        const proposed = yield* mutator(current);
        const next = yield* Schema.decodeUnknownEffect(options.schema)(
          proposed,
        ).pipe(Effect.mapError(() => storeError("invalid_data")));
        yield* writeAtomic(next);
        return next;
      })),
    inspect: withLock(Effect.gen(function*() {
      const exists = yield* fileSystem.exists(options.path).pipe(
        Effect.mapError(() => storeError("storage_unavailable")),
      );
      if (!exists) return { exists: false, valid: false };
      const metadata = yield* fileSystem.stat(options.path).pipe(
        Effect.mapError(() => storeError("storage_unavailable")),
      );
      const valid = yield* readValidated.pipe(
        Effect.as(true),
        Effect.catchTag("AtomicJsonStoreError", (error) =>
          error.code === "invalid_data"
            ? Effect.succeed(false)
            : Effect.fail(error)),
      );
      return {
        exists: true,
        valid,
        mode: metadata.mode & 0o777,
      };
    })),
  } satisfies AtomicJsonStore<T>;
});

function storeError(code: AtomicJsonStoreError["code"]) {
  return AtomicJsonStoreError.make({ code });
}

function isLockContention(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ELOCKED"
  );
}
