import {
  Clock,
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  Semaphore,
} from "effect";

export type MemoryActivityProjection =
  | { readonly kind: "human" | "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly toolName: string };

export interface CompletedMemorySession {
  readonly sessionId: string;
  readonly completedAt: string;
}

export interface MemoryActivityState {
  readonly version: 1;
  readonly firstSeenAt: string;
  readonly lastDreamDiscoveryAt?: string;
  readonly lastSuccessfulDreamAt?: string;
  readonly completedSessions: ReadonlyArray<CompletedMemorySession>;
}

export interface DreamDecision {
  readonly currentSessionId: string;
  readonly now: Date;
  readonly minHours: number;
  readonly minPriorSessions: number;
}

export type DreamLockClaim =
  | { readonly acquired: false; readonly staleRecovered: false }
  | {
    readonly acquired: true;
    readonly staleRecovered: boolean;
    readonly owner: string;
    readonly token: string;
    readonly startedAt: string;
  };

export interface MemoryActivityOptions {
  readonly now?: Effect.Effect<Date>;
  readonly maxFileBytes?: number;
  readonly maxSessionFiles?: number;
  readonly retentionDays?: number;
}

export interface MemoryActivityMutationOptions {
  readonly beforeCommit?: Effect.Effect<void, unknown>;
}

export interface MemoryActivityReadOptions {
  readonly beforeRead?: Effect.Effect<void, unknown>;
}

const MemoryActivityErrorCode = Schema.Literals([
  "already_exists",
  "guard_failed",
  "invalid_state",
  "invalid_utf8",
  "io_failed",
  "not_found",
  "unsafe_path",
]);

export class MemoryActivityError extends Schema.TaggedErrorClass<MemoryActivityError>()(
  "MemoryActivityError",
  {
    cause: Schema.Unknown,
    code: MemoryActivityErrorCode,
    message: Schema.String,
    path: Schema.optional(Schema.String),
  },
) {}

export interface MemoryActivityStore {
  readonly logsRoot: string;
  readonly statePath: string;
  ensureLayout(): Effect.Effect<void, MemoryActivityError>;
  append(
    sessionId: string,
    projection: MemoryActivityProjection,
    options?: MemoryActivityMutationOptions,
  ): Effect.Effect<void, MemoryActivityError>;
  readRecent(
    days?: number,
    options?: MemoryActivityReadOptions,
  ): Effect.Effect<string, MemoryActivityError>;
  ensureState(at?: Date): Effect.Effect<MemoryActivityState, MemoryActivityError>;
  readState(): Effect.Effect<MemoryActivityState, MemoryActivityError>;
  completeSession(
    sessionId: string,
    at?: Date,
  ): Effect.Effect<void, MemoryActivityError>;
  markDreamDiscovery(
    at?: Date,
    options?: MemoryActivityMutationOptions,
  ): Effect.Effect<void, MemoryActivityError>;
  markDreamSuccess(
    at?: Date,
    options?: MemoryActivityMutationOptions,
  ): Effect.Effect<void, MemoryActivityError>;
  claimDreamLock(owner: string): Effect.Effect<DreamLockClaim, MemoryActivityError>;
  releaseDreamLock(claim: DreamLockClaim): Effect.Effect<void, MemoryActivityError>;
}

const DEFAULT_MAX_FILE_BYTES = 32_768;
const DEFAULT_MAX_SESSION_FILES = 64;
const DEFAULT_RETENTION_DAYS = 3;
const MAX_PROJECTION_TEXT = 8_192;
const LOCK_STALE_MS = 60 * 60 * 1_000;
const IsoTimestamp = Schema.String;
const CompletedMemorySessionSchema = Schema.Struct({
  sessionId: Schema.String,
  completedAt: IsoTimestamp,
});
const MemoryActivityStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  firstSeenAt: IsoTimestamp,
  lastDreamDiscoveryAt: Schema.optional(IsoTimestamp),
  lastSuccessfulDreamAt: Schema.optional(IsoTimestamp),
  completedSessions: Schema.Array(CompletedMemorySessionSchema),
});
const DreamLockSchema = Schema.Struct({
  owner: Schema.String,
  token: Schema.String,
  startedAt: IsoTimestamp,
});
const StateJson = Schema.fromJsonString(MemoryActivityStateSchema);
const DreamLockJson = Schema.fromJsonString(DreamLockSchema);

function activityError(
  code: MemoryActivityError["code"],
  message: string,
  cause: unknown = message,
  path?: string,
) {
  return MemoryActivityError.make({
    cause,
    code,
    message,
    ...(path === undefined ? {} : { path }),
  });
}

function platformTag(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("reason" in error) ||
    typeof error.reason !== "object" ||
    error.reason === null ||
    !("_tag" in error.reason) ||
    typeof error.reason._tag !== "string"
  ) return undefined;
  return error.reason._tag;
}

function mapIo(path: string, operation: string) {
  return (cause: unknown) => {
    const tag = platformTag(cause);
    const code = tag === "NotFound"
      ? "not_found"
      : tag === "AlreadyExists"
      ? "already_exists"
      : "io_failed";
    return activityError(
      code,
      `Mate memory activity could not ${operation} ${path}.`,
      cause,
      path,
    );
  };
}

function runGuard(guard: Effect.Effect<void, unknown> | undefined) {
  return (guard ?? Effect.void).pipe(
    Effect.mapError((cause) =>
      activityError(
        "guard_failed",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      )
    ),
  );
}

function failActivity(
  code: MemoryActivityError["code"],
  message: string,
  path?: string,
) {
  return Effect.fail(activityError(code, message, message, path));
}

function defaultNow() {
  return Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));
}

function unavailableDreamLock(): DreamLockClaim {
  return { acquired: false, staleRecovered: false };
}

export function createMemoryActivityStore(
  home: string,
  options: MemoryActivityOptions = {},
): Effect.Effect<
  MemoryActivityStore,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const mutationLock = yield* Semaphore.make(1);
    const homeRoot = paths.resolve(home);
    const memoryRoot = paths.join(homeRoot, "memory");
    const logsRoot = paths.join(memoryRoot, "logs");
    const statePath = paths.join(
      homeRoot,
      ".local",
      "state",
      "agentos",
      "memory.json",
    );
    const lockPath = paths.join(memoryRoot, ".consolidate-lock");
    const now = options.now ?? defaultNow();
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

    const entryType = (path: string) =>
      fileSystem.readLink(path).pipe(
        Effect.as("SymbolicLink"),
        Effect.catch(() =>
          fileSystem.stat(path).pipe(
            Effect.map((info) => info.type),
            Effect.mapError(mapIo(path, "inspect")),
          )
        ),
      );

    const ensureSafeDirectory = (path: string) =>
      Effect.gen(function*() {
        const inspected = yield* entryType(path).pipe(Effect.result);
        if (Result.isFailure(inspected)) {
          if (inspected.failure.code !== "not_found") {
            return yield* inspected.failure;
          }
          yield* fileSystem.makeDirectory(path, {
            recursive: true,
            mode: 0o700,
          }).pipe(Effect.mapError(mapIo(path, "create directory")));
          return;
        }
        if (inspected.success === "SymbolicLink") {
          return yield* failActivity(
            "unsafe_path",
            `${path} must not be a symbolic link`,
            path,
          );
        }
        if (inspected.success !== "Directory") {
          return yield* failActivity(
            "unsafe_path",
            `${path} must be a directory`,
            path,
          );
        }
      });

    const ensureSafeContainedDirectory = (root: string, target: string) =>
      Effect.gen(function*() {
        const absoluteRoot = paths.resolve(root);
        const absoluteTarget = paths.resolve(target);
        const fromRoot = paths.relative(absoluteRoot, absoluteTarget);
        if (
          fromRoot === ".." ||
          fromRoot.startsWith(`..${paths.sep}`) ||
          fromRoot.startsWith(paths.sep)
        ) {
          return yield* failActivity(
            "unsafe_path",
            "activity state path escapes the Mate home",
            target,
          );
        }
        yield* ensureSafeDirectory(absoluteRoot);
        let cursor = absoluteRoot;
        for (const segment of fromRoot ? fromRoot.split(paths.sep) : []) {
          cursor = paths.join(cursor, segment);
          const inspected = yield* entryType(cursor).pipe(Effect.result);
          if (Result.isFailure(inspected)) {
            if (inspected.failure.code !== "not_found") {
              return yield* inspected.failure;
            }
            yield* fileSystem.makeDirectory(cursor, { mode: 0o700 }).pipe(
              Effect.mapError(mapIo(cursor, "create directory")),
            );
            continue;
          }
          if (inspected.success === "SymbolicLink") {
            return yield* failActivity(
              "unsafe_path",
              `activity state path crosses symbolic link ${cursor}`,
              cursor,
            );
          }
          if (inspected.success !== "Directory") {
            return yield* failActivity(
              "unsafe_path",
              `activity state path parent is not a directory: ${cursor}`,
              cursor,
            );
          }
        }
      });

    const ensureSafeStateFile = () =>
      Effect.gen(function*() {
        yield* ensureSafeContainedDirectory(homeRoot, paths.dirname(statePath));
        const inspected = yield* entryType(statePath).pipe(Effect.result);
        if (Result.isFailure(inspected)) {
          if (inspected.failure.code === "not_found") return;
          return yield* inspected.failure;
        }
        if (inspected.success === "SymbolicLink") {
          return yield* failActivity(
            "unsafe_path",
            `${statePath} must not be a symbolic link`,
            statePath,
          );
        }
        if (inspected.success !== "File") {
          return yield* failActivity(
            "unsafe_path",
            `${statePath} must be a regular file`,
            statePath,
          );
        }
      });

    const ensureSafeActivityPath = (root: string, target: string) =>
      Effect.gen(function*() {
        const rootReal = yield* fileSystem.realPath(root).pipe(
          Effect.mapError(mapIo(root, "resolve")),
        );
        const fromRoot = paths.relative(root, target);
        if (
          !fromRoot ||
          fromRoot === ".." ||
          fromRoot.startsWith(`..${paths.sep}`) ||
          fromRoot.startsWith(paths.sep)
        ) {
          return yield* failActivity(
            "unsafe_path",
            "activity path escapes the Mate memory logs root",
            target,
          );
        }
        let cursor = root;
        const segments = fromRoot.split(paths.sep);
        for (const [index, segment] of segments.entries()) {
          const isLeaf = index === segments.length - 1;
          cursor = paths.join(cursor, segment);
          const inspected = yield* entryType(cursor).pipe(Effect.result);
          if (Result.isFailure(inspected)) {
            if (inspected.failure.code !== "not_found") {
              return yield* inspected.failure;
            }
            if (isLeaf) break;
            yield* fileSystem.makeDirectory(cursor, { mode: 0o700 }).pipe(
              Effect.mapError(mapIo(cursor, "create directory")),
            );
            continue;
          }
          if (inspected.success === "SymbolicLink") {
            return yield* failActivity(
              "unsafe_path",
              `activity path crosses symbolic link ${cursor}`,
              cursor,
            );
          }
          if (!isLeaf && inspected.success !== "Directory") {
            return yield* failActivity(
              "unsafe_path",
              `activity path parent is not a directory: ${cursor}`,
              cursor,
            );
          }
          if (isLeaf && inspected.success !== "File") {
            return yield* failActivity(
              "unsafe_path",
              `activity path must be a regular file: ${cursor}`,
              cursor,
            );
          }
          const actual = yield* fileSystem.realPath(cursor).pipe(
            Effect.mapError(mapIo(cursor, "resolve")),
          );
          if (actual !== rootReal && !actual.startsWith(`${rootReal}${paths.sep}`)) {
            return yield* failActivity(
              "unsafe_path",
              "activity path escapes through a symbolic link",
              cursor,
            );
          }
        }
      });

    const ensureLayout = () =>
      Effect.gen(function*() {
        yield* ensureSafeDirectory(memoryRoot);
        yield* ensureSafeDirectory(logsRoot);
        yield* ensureSafeContainedDirectory(homeRoot, paths.dirname(statePath));
        yield* ensureSafeStateFile();
      });

    const atomicWrite = (
      path: string,
      content: string,
      mutation: MemoryActivityMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(mapIo(path, "generate temporary identity for")),
        );
        const next = `${path}.agentos-next-${id}`;
        const write = Effect.scoped(Effect.gen(function*() {
          const file = yield* fileSystem.open(next, {
            flag: "wx",
            mode: 0o600,
          }).pipe(Effect.mapError(mapIo(next, "open")));
          yield* file.writeAll(new TextEncoder().encode(content)).pipe(
            Effect.mapError(mapIo(next, "write")),
          );
          yield* file.sync.pipe(Effect.mapError(mapIo(next, "sync")));
        }));
        yield* write.pipe(
          Effect.andThen(runGuard(mutation.beforeCommit)),
          Effect.andThen(
            fileSystem.rename(next, path).pipe(
              Effect.mapError(mapIo(path, "commit")),
            ),
          ),
          Effect.ensuring(
            fileSystem.remove(next, { force: true }).pipe(Effect.ignore),
          ),
        );
      });

    const readUtf8 = (
      path: string,
      beforeRead?: Effect.Effect<void, unknown>,
    ) =>
      Effect.gen(function*() {
        yield* runGuard(beforeRead);
        const contents = yield* fileSystem.readFile(path).pipe(
          Effect.mapError(mapIo(path, "read")),
        );
        yield* runGuard(beforeRead);
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
          catch: (cause) =>
            activityError(
              "invalid_utf8",
              `${path} is not valid UTF-8`,
              cause,
              path,
            ),
        });
      });

    const digestSession = (sessionId: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(sessionId)).pipe(
        Effect.mapError(mapIo(logsRoot, "hash session identity for")),
        Effect.map((digest) =>
          Array.from(digest)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16)
        ),
      );

    const projectionPath = (sessionId: string, at: Date) =>
      digestSession(sessionId).pipe(
        Effect.map((digest) => {
          const year = String(at.getUTCFullYear());
          const month = String(at.getUTCMonth() + 1).padStart(2, "0");
          const day = String(at.getUTCDate()).padStart(2, "0");
          return paths.join(logsRoot, year, month, day, `${digest}.md`);
        }),
      );

    type ActivityFile = { readonly path: string; readonly label: string; readonly day: number };
    const activityFiles = (beforeRead?: Effect.Effect<void, unknown>) =>
      Effect.gen(function*() {
        const results: ActivityFile[] = [];
        const walk = (
          directory: string,
          segments: ReadonlyArray<string>,
        ): Effect.Effect<void, MemoryActivityError> =>
          Effect.gen(function*() {
            yield* runGuard(beforeRead);
            const listed = yield* fileSystem.readDirectory(directory).pipe(
              Effect.mapError(mapIo(directory, "list")),
              Effect.result,
            );
            yield* runGuard(beforeRead);
            if (Result.isFailure(listed)) {
              if (listed.failure.code === "not_found") return;
              return yield* listed.failure;
            }
            for (const name of listed.success.sort()) {
              const path = paths.join(directory, name);
              const kind = yield* entryType(path);
              if (kind === "SymbolicLink") {
                return yield* failActivity(
                  "unsafe_path",
                  `activity path crosses symbolic link ${path}`,
                  path,
                );
              }
              const next = [...segments, name];
              if (kind === "Directory") yield* walk(path, next);
              else if (kind === "File" && next.length === 4 && name.endsWith(".md")) {
                const year = next[0];
                const month = next[1];
                const day = next[2];
                const parsedDay = Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
                if (Number.isFinite(parsedDay)) {
                  results.push({ path, label: next.join("/"), day: parsedDay });
                }
              }
            }
          });
        yield* walk(logsRoot, []);
        return results;
      });

    const pruneLogs = (at: Date) =>
      Effect.gen(function*() {
        const cutoff = startOfUtcDay(
          new Date(at.getTime() - retentionDays * 86_400_000),
        );
        const files = (yield* activityFiles()).sort((left, right) =>
          left.path.localeCompare(right.path)
        );
        const retained = files.filter(({ day }) => day >= cutoff);
        const remove = [
          ...files.filter(({ day }) => day < cutoff),
          ...retained.slice(0, Math.max(0, retained.length - maxSessionFiles)),
        ];
        yield* Effect.forEach(
          remove,
          ({ path }) =>
            fileSystem.remove(path, { force: true }).pipe(
              Effect.mapError(mapIo(path, "prune")),
            ),
          { concurrency: "unbounded", discard: true },
        );
      });

    const append = (
      sessionId: string,
      projection: MemoryActivityProjection,
      mutation: MemoryActivityMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* ensureLayout();
        const at = yield* now;
        const path = yield* projectionPath(sessionId, at);
        yield* ensureSafeActivityPath(logsRoot, path);
        const existing = yield* readUtf8(path).pipe(Effect.result);
        const current = Result.isSuccess(existing)
          ? existing.success
          : existing.failure.code === "not_found"
          ? ""
          : yield* existing.failure;
        const line = projectionLine(projection);
        if (!line) return;
        yield* atomicWrite(
          path,
          truncateUtf8(`${current}${line}\n`, maxFileBytes),
          {
            beforeCommit: ensureSafeActivityPath(logsRoot, path).pipe(
              Effect.andThen(runGuard(mutation.beforeCommit)),
            ),
          },
        );
        yield* pruneLogs(at);
      });

    const readRecent = (
      days = retentionDays,
      readOptions: MemoryActivityReadOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(readOptions.beforeRead);
        yield* ensureLayout();
        yield* runGuard(readOptions.beforeRead);
        const at = yield* now;
        const cutoff = startOfUtcDay(
          new Date(at.getTime() - Math.max(1, days) * 86_400_000),
        );
        const files = (yield* activityFiles(readOptions.beforeRead))
          .filter(({ day }) => day >= cutoff)
          .sort((left, right) => left.path.localeCompare(right.path))
          .slice(-maxSessionFiles);
        const aggregateLimit = maxFileBytes * Math.min(maxSessionFiles, 8);
        let result = "";
        let bytes = 0;
        for (const file of files) {
          yield* runGuard(readOptions.beforeRead);
          const content = yield* readUtf8(file.path, readOptions.beforeRead);
          yield* runGuard(readOptions.beforeRead);
          const framing = `${result ? "\n" : ""}## ${file.label}\n`;
          const remaining = aggregateLimit - bytes;
          const framingBytes = Buffer.byteLength(framing);
          if (framingBytes > remaining) break;
          result += framing;
          bytes += framingBytes;
          const bounded = truncateUtf8(content, aggregateLimit - bytes);
          result += bounded;
          bytes += Buffer.byteLength(bounded);
          if (bytes >= aggregateLimit) break;
        }
        return truncateUtf8(result, aggregateLimit);
      });

    const encodeState = (state: MemoryActivityState) =>
      Schema.encodeEffect(StateJson)(state).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.mapError((cause) =>
          activityError(
            "invalid_state",
            "Mate memory coordination state could not be encoded.",
            cause,
            statePath,
          )
        ),
      );

    const readStateUnlocked = () =>
      Effect.gen(function*() {
        yield* ensureSafeStateFile();
        const source = yield* fileSystem.readFileString(statePath).pipe(
          Effect.mapError(mapIo(statePath, "read")),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          StateJson,
          { onExcessProperty: "error" },
        )(source).pipe(
          Effect.mapError((cause) =>
            activityError(
              "invalid_state",
              `${statePath} contains invalid memory coordination state`,
              cause,
              statePath,
            )
          ),
        );
        const dates = [
          decoded.firstSeenAt,
          decoded.lastDreamDiscoveryAt,
          decoded.lastSuccessfulDreamAt,
          ...decoded.completedSessions.map(({ completedAt }) => completedAt),
        ].filter((value) => value !== undefined);
        if (!dates.every(isNormalizedIsoDate)) {
          return yield* failActivity(
            "invalid_state",
            `${statePath} contains invalid memory coordination state`,
            statePath,
          );
        }
        return decoded;
      });

    const writeState = (
      state: MemoryActivityState,
      mutation: MemoryActivityMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* ensureSafeStateFile();
        const encoded = yield* encodeState(state);
        yield* atomicWrite(statePath, encoded, {
          beforeCommit: ensureSafeStateFile().pipe(
            Effect.andThen(runGuard(mutation.beforeCommit)),
          ),
        });
      });

    const ensureStateUnlocked = (at: Date) =>
      Effect.gen(function*() {
        yield* ensureLayout();
        const existing = yield* readStateUnlocked().pipe(Effect.result);
        if (Result.isSuccess(existing)) return existing.success;
        if (existing.failure.code !== "not_found") return yield* existing.failure;
        const state: MemoryActivityState = {
          version: 1,
          firstSeenAt: at.toISOString(),
          completedSessions: [],
        };
        yield* writeState(state);
        return state;
      });

    const atOrNow = (at: Date | undefined) =>
      at === undefined ? now : Effect.succeed(at);

    const ensureState = (at?: Date) =>
      mutationLock.withPermit(
        Effect.flatMap(atOrNow(at), ensureStateUnlocked),
      );

    const readState = () =>
      ensureLayout().pipe(Effect.andThen(readStateUnlocked()));

    const completeSession = (sessionId: string, at?: Date) =>
      mutationLock.withPermit(Effect.gen(function*() {
        const completedAt = yield* atOrNow(at);
        const state = yield* ensureStateUnlocked(completedAt);
        const completed = new Map(
          state.completedSessions.map((session) => [session.sessionId, session]),
        );
        const existing = completed.get(sessionId);
        const next = { sessionId, completedAt: completedAt.toISOString() };
        if (existing === undefined || existing.completedAt < next.completedAt) {
          completed.set(sessionId, next);
        }
        yield* writeState({
          ...state,
          completedSessions: [...completed.values()]
            .sort((left, right) =>
              left.completedAt.localeCompare(right.completedAt)
            )
            .slice(-maxSessionFiles),
        });
      }));

    const markDreamDiscovery = (
      at?: Date,
      mutation: MemoryActivityMutationOptions = {},
    ) =>
      mutationLock.withPermit(Effect.gen(function*() {
        const discoveredAt = yield* atOrNow(at);
        const state = yield* ensureStateUnlocked(discoveredAt);
        yield* writeState({
          ...state,
          lastDreamDiscoveryAt: discoveredAt.toISOString(),
        }, mutation);
      }));

    const markDreamSuccess = (
      at?: Date,
      mutation: MemoryActivityMutationOptions = {},
    ) =>
      mutationLock.withPermit(Effect.gen(function*() {
        const successfulAt = yield* atOrNow(at);
        const state = yield* ensureStateUnlocked(successfulAt);
        yield* writeState({
          ...state,
          lastSuccessfulDreamAt: successfulAt.toISOString(),
          lastDreamDiscoveryAt: successfulAt.toISOString(),
        }, mutation);
      }));

    const writeExclusive = (path: string, value: typeof DreamLockSchema.Type) =>
      Effect.gen(function*() {
        const encoded = yield* Schema.encodeEffect(DreamLockJson)(value).pipe(
          Effect.mapError((cause) =>
            activityError(
              "invalid_state",
              "Mate memory Dream lock could not be encoded.",
              cause,
              path,
            )
          ),
        );
        yield* Effect.scoped(Effect.gen(function*() {
          const file = yield* fileSystem.open(path, {
            flag: "wx",
            mode: 0o600,
          }).pipe(Effect.mapError(mapIo(path, "create")));
          yield* file.writeAll(new TextEncoder().encode(`${encoded}\n`)).pipe(
            Effect.mapError(mapIo(path, "write")),
          );
          yield* file.sync.pipe(Effect.mapError(mapIo(path, "sync")));
        }));
      });

    const readLock = (path: string) =>
      fileSystem.readFileString(path).pipe(
        Effect.flatMap((source) =>
          Schema.decodeUnknownEffect(
            DreamLockJson,
            { onExcessProperty: "error" },
          )(source)
        ),
        Effect.option,
        Effect.map((decoded) => {
          const lock = Option.getOrUndefined(decoded);
          return lock !== undefined && isNormalizedIsoDate(lock.startedAt)
            ? lock
            : undefined;
        }),
      );

    const claimDreamLock = (owner: string) =>
      Effect.gen(function*() {
        yield* ensureLayout();
        const startedAt = (yield* now).toISOString();
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(mapIo(lockPath, "create identity for")),
        );
        const claim: Extract<DreamLockClaim, { acquired: true }> = {
          acquired: true,
          staleRecovered: false,
          owner,
          token,
          startedAt,
        };
        const initial = yield* writeExclusive(lockPath, claim).pipe(Effect.result);
        if (Result.isSuccess(initial)) return claim;
        if (initial.failure.code !== "already_exists") return yield* initial.failure;
        yield* ensureSafeActivityPath(memoryRoot, lockPath);
        const existing = yield* readLock(lockPath);
        if (
          existing !== undefined &&
          (yield* now).getTime() - new Date(existing.startedAt).getTime() <= LOCK_STALE_MS
        ) return unavailableDreamLock();
        yield* fileSystem.remove(lockPath, { force: true }).pipe(
          Effect.mapError(mapIo(lockPath, "remove stale lock")),
        );
        const recovered: Extract<DreamLockClaim, { acquired: true }> = {
          ...claim,
          staleRecovered: true,
        };
        const retry = yield* writeExclusive(lockPath, recovered).pipe(Effect.result);
        if (Result.isSuccess(retry)) return recovered;
        if (retry.failure.code === "already_exists") {
          return unavailableDreamLock();
        }
        return yield* retry.failure;
      });

    const releaseDreamLock = (claim: DreamLockClaim) =>
      Effect.gen(function*() {
        if (!claim.acquired) return;
        yield* ensureLayout();
        yield* ensureSafeActivityPath(memoryRoot, lockPath);
        const existing = yield* readLock(lockPath);
        if (
          existing === undefined ||
          existing.owner !== claim.owner ||
          existing.token !== claim.token
        ) return;
        yield* fileSystem.remove(lockPath, { force: true }).pipe(
          Effect.mapError(mapIo(lockPath, "release")),
        );
      });

    return {
      logsRoot,
      statePath,
      ensureLayout,
      append,
      readRecent,
      ensureState,
      readState,
      completeSession,
      markDreamDiscovery,
      markDreamSuccess,
      claimDreamLock,
      releaseDreamLock,
    } satisfies MemoryActivityStore;
  });
}

export function shouldDream(
  state: MemoryActivityState,
  decision: DreamDecision,
): boolean {
  const reference = new Date(
    state.lastSuccessfulDreamAt ?? state.firstSeenAt,
  ).getTime();
  if (
    decision.now.getTime() - reference <
    decision.minHours * 60 * 60 * 1_000
  ) return false;
  const prior = state.completedSessions.filter(
    ({ sessionId, completedAt }) =>
      sessionId !== decision.currentSessionId &&
      new Date(completedAt).getTime() > reference,
  );
  return prior.length >= decision.minPriorSessions;
}

function projectionLine(projection: MemoryActivityProjection): string {
  if (projection.kind === "tool") {
    const safeName = /^[a-zA-Z0-9_.-]+/.exec(projection.toolName)?.[0];
    return safeName ? `. ${safeName}` : "";
  }
  const marker = projection.kind === "human" ? ">" : "<";
  return `${marker} ${redact(projection.text).slice(0, MAX_PROJECTION_TEXT)}`;
}

export function redact(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(authorization\s*:\s*)bearer\s+\S+/gi, "$1[REDACTED]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /["']?\b(api[_-]?key|token|password|passwd|secret)\b["']?\s*[:=]\s*["']?[^\s"'`,}\]]{1,256}/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(?:sk|ghp|github_pat|sk-proj|sk-ant|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

function isNormalizedIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}
