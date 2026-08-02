import {
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

import {
  parseTopicFile,
  serializeTopicFile,
  type ParsedTopic,
  type TopicMetadata,
} from "./schema.ts";
import {
  resolveMateMemoryPolicy,
  type MateMemoryPolicy,
} from "./policy.ts";

export interface TopicWrite {
  readonly relativePath: string;
  readonly metadata: TopicMetadata;
  readonly body: string;
}

export interface StoredTopic extends ParsedTopic {
  readonly relativePath: string;
  readonly bytes: number;
}

export interface StartupMemoryContext {
  index: string;
  pinned: StoredTopic[];
  inventory: Array<{
    relativePath: string;
    type: TopicMetadata["type"];
    scope: string;
    modified: string;
    pinned: boolean;
  }>;
  degraded: string[];
}

export interface MemoryReadOptions {
  readonly beforeRead?: Effect.Effect<void, unknown>;
  readonly beforeCommit?: Effect.Effect<void, unknown>;
}

export interface StampOptions extends MemoryReadOptions {
  readonly now?: Date;
  readonly enforceTopicLimit?: boolean;
}

export interface MemoryMutationOptions extends MemoryReadOptions {}

const MateMemoryStoreErrorCode = Schema.Literals([
  "guard_failed",
  "invalid_path",
  "invalid_topic",
  "io_failed",
  "limit_exceeded",
  "unsafe_path",
]);

export class MateMemoryStoreError extends Schema.TaggedErrorClass<MateMemoryStoreError>()(
  "MateMemoryStoreError",
  {
    cause: Schema.Unknown,
    code: MateMemoryStoreErrorCode,
    message: Schema.String,
    path: Schema.optional(Schema.String),
  },
) {}

export interface MateMemoryStore {
  readonly root: string;
  readonly policy: MateMemoryPolicy;
  ensureLayout(options?: MemoryReadOptions): Effect.Effect<void, MateMemoryStoreError>;
  readStartupContext(
    options?: MemoryReadOptions,
  ): Effect.Effect<StartupMemoryContext, MateMemoryStoreError>;
  listTopics(
    options?: MemoryReadOptions,
  ): Effect.Effect<ReadonlyArray<StoredTopic>, MateMemoryStoreError>;
  readTopic(
    relativePath: string,
    options?: MemoryReadOptions,
  ): Effect.Effect<StoredTopic, MateMemoryStoreError>;
  validateAndStamp(
    relativePath: string,
    options?: StampOptions,
  ): Effect.Effect<StoredTopic, MateMemoryStoreError>;
  writeTopic(
    topic: TopicWrite,
    options?: MemoryMutationOptions,
  ): Effect.Effect<StoredTopic, MateMemoryStoreError>;
  deleteTopic(
    relativePath: string,
    options?: MemoryMutationOptions,
  ): Effect.Effect<void, MateMemoryStoreError>;
  writeIndex(
    content: string,
    options?: MemoryMutationOptions,
  ): Effect.Effect<void, MateMemoryStoreError>;
  resolveMemoryPath(
    relativePath: string,
    options?: MemoryReadOptions,
  ): Effect.Effect<string, MateMemoryStoreError>;
}

const INDEX_NAME = "MEMORY.md";
const EMPTY_INDEX = "# Memory index\n";

function storeError(
  code: MateMemoryStoreError["code"],
  message: string,
  cause: unknown = message,
  path?: string,
) {
  return MateMemoryStoreError.make({
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
  return (cause: unknown) =>
    storeError(
      "io_failed",
      `Mate memory could not ${operation} ${path}.`,
      cause,
      path,
    );
}

function runGuard(guard: Effect.Effect<void, unknown> | undefined) {
  return (guard ?? Effect.void).pipe(
    Effect.mapError((cause) =>
      storeError(
        "guard_failed",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      )
    ),
  );
}

function failStore(
  code: MateMemoryStoreError["code"],
  message: string,
  path?: string,
) {
  return Effect.fail(storeError(code, message, message, path));
}

export function createMateMemoryStore(
  home: string,
  overrides: Partial<MateMemoryPolicy> = {},
): Effect.Effect<
  MateMemoryStore,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = paths.resolve(home, "memory");
    const policy = resolveMateMemoryPolicy(overrides);

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

    const ensureSafeDirectory = (
      path: string,
      beforeRead?: Effect.Effect<void, unknown>,
    ): Effect.Effect<void, MateMemoryStoreError> =>
      Effect.gen(function*() {
        yield* runGuard(beforeRead);
        const inspected = yield* fileSystem.readLink(path).pipe(
          Effect.as("SymbolicLink"),
          Effect.catch((linkError) =>
            fileSystem.stat(path).pipe(
              Effect.map((info) => info.type),
              Effect.catch((statError) =>
                platformTag(statError) === "NotFound" &&
                  platformTag(linkError) === "NotFound"
                  ? Effect.succeed("Missing")
                  : Effect.fail(mapIo(path, "inspect")(statError))
              ),
            )
          ),
        );
        yield* runGuard(beforeRead);
        if (inspected === "SymbolicLink") {
          return yield* failStore(
            "unsafe_path",
            `${path} must not be a symbolic link`,
            path,
          );
        }
        if (inspected === "Missing") {
          yield* fileSystem.makeDirectory(path, {
            recursive: true,
            mode: 0o700,
          }).pipe(Effect.mapError(mapIo(path, "create directory")));
          yield* runGuard(beforeRead);
          return;
        }
        if (inspected !== "Directory") {
          return yield* failStore(
            "unsafe_path",
            `${path} must be a directory`,
            path,
          );
        }
      });

    const atomicWrite = (
      path: string,
      content: string,
      options: MemoryMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* fileSystem.makeDirectory(paths.dirname(path), {
          recursive: true,
          mode: 0o700,
        }).pipe(Effect.mapError(mapIo(path, "create parent directory for")));
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
          Effect.andThen(runGuard(options.beforeCommit)),
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

    const rejectSymlinkTraversal = (
      target: string,
      beforeRead?: Effect.Effect<void, unknown>,
    ) =>
      Effect.gen(function*() {
        yield* ensureSafeDirectory(root, beforeRead);
        yield* runGuard(beforeRead);
        const rootReal = yield* fileSystem.realPath(root).pipe(
          Effect.mapError(mapIo(root, "resolve")),
        );
        yield* runGuard(beforeRead);
        const fromRoot = paths.relative(root, target);
        let cursor = root;
        const segments = fromRoot.split(paths.sep);
        for (const [index, segment] of segments.entries()) {
          const isLeaf = index === segments.length - 1;
          cursor = paths.join(cursor, segment);
          yield* runGuard(beforeRead);
          const inspected = yield* entryType(cursor).pipe(Effect.result);
          yield* runGuard(beforeRead);
          if (Result.isFailure(inspected)) {
            if (platformTag(inspected.failure.cause) === "NotFound") {
              if (isLeaf) break;
              yield* fileSystem.makeDirectory(cursor, { mode: 0o700 }).pipe(
                Effect.mapError(mapIo(cursor, "create directory")),
              );
              yield* runGuard(beforeRead);
              continue;
            }
            return yield* inspected.failure;
          }
          if (inspected.success === "SymbolicLink") {
            return yield* failStore(
              "unsafe_path",
              `memory path crosses symbolic link ${cursor}`,
              cursor,
            );
          }
          if (!isLeaf && inspected.success !== "Directory") {
            return yield* failStore(
              "unsafe_path",
              `memory path parent is not a directory: ${cursor}`,
              cursor,
            );
          }
          if (isLeaf && inspected.success !== "File") {
            return yield* failStore(
              "unsafe_path",
              `memory path must be a regular file: ${cursor}`,
              cursor,
            );
          }
          yield* runGuard(beforeRead);
          const actual = yield* fileSystem.realPath(cursor).pipe(
            Effect.mapError(mapIo(cursor, "resolve")),
          );
          yield* runGuard(beforeRead);
          if (actual !== rootReal && !actual.startsWith(`${rootReal}${paths.sep}`)) {
            return yield* failStore(
              "unsafe_path",
              "memory path escapes through a symbolic link",
              cursor,
            );
          }
        }
      });

    const canonicalTopicPath = (value: string) => {
      const normalized = value.replaceAll("\\", "/");
      if (
        paths.isAbsolute(value) ||
        !normalized.startsWith("topics/") ||
        normalized.includes("/../") ||
        normalized.includes("/./") ||
        normalized.endsWith("/") ||
        !normalized.endsWith(".md")
      ) {
        return failStore(
          "invalid_path",
          "topic path must be a relative topics/*.md path",
          value,
        );
      }
      const invalid = normalized.split("/").some((segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(segment)
      );
      return invalid
        ? failStore(
          "invalid_path",
          "topic path must use lowercase safe segments beneath topics/",
          value,
        )
        : Effect.succeed(normalized);
    };

    const resolveMemoryPath = (
      relativePath: string,
      options: MemoryReadOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        const normalized = relativePath === INDEX_NAME
          ? INDEX_NAME
          : yield* canonicalTopicPath(relativePath);
        if (paths.isAbsolute(normalized)) {
          return yield* failStore(
            "invalid_path",
            "memory path must be relative",
            relativePath,
          );
        }
        const path = paths.resolve(root, normalized);
        const fromRoot = paths.relative(root, path);
        if (
          fromRoot === ".." ||
          fromRoot.startsWith(`..${paths.sep}`) ||
          paths.isAbsolute(fromRoot)
        ) {
          return yield* failStore(
            "invalid_path",
            "memory path escapes the Mate memory root",
            relativePath,
          );
        }
        yield* rejectSymlinkTraversal(path, options.beforeRead);
        yield* runGuard(options.beforeRead);
        return path;
      });

    const readUtf8Prefix = (
      path: string,
      maxBytes: number,
      beforeRead?: Effect.Effect<void, unknown>,
    ) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        return failStore(
          "limit_exceeded",
          "memory byte limit must be a positive safe integer",
          path,
        );
      }
      return Effect.scoped(Effect.gen(function*() {
        yield* runGuard(beforeRead);
        const file = yield* fileSystem.open(path, { flag: "r" }).pipe(
          Effect.mapError(mapIo(path, "open")),
        );
        yield* runGuard(beforeRead);
        const read = yield* file.readAlloc(maxBytes + 1).pipe(
          Effect.mapError(mapIo(path, "read")),
        );
        yield* runGuard(beforeRead);
        const contents = Option.getOrElse(read, () => new Uint8Array());
        const truncated = contents.byteLength > maxBytes;
        const prefix = contents.subarray(0, Math.min(contents.byteLength, maxBytes));
        return yield* Effect.try({
          try: () => ({
            text: new TextDecoder("utf-8", { fatal: true }).decode(prefix, {
              stream: truncated,
            }),
            truncated,
          }),
          catch: (cause) =>
            storeError(
              "invalid_topic",
              `${path} is not valid UTF-8`,
              cause,
              path,
            ),
        });
      }));
    };

    const topicPaths = (
      beforeRead?: Effect.Effect<void, unknown>,
      maxResults = Number.POSITIVE_INFINITY,
    ) =>
      Effect.gen(function*() {
        const base = paths.join(root, "topics");
        const results: string[] = [];
        const walk = (directory: string, prefix: string): Effect.Effect<
          void,
          MateMemoryStoreError
        > =>
          Effect.gen(function*() {
            yield* runGuard(beforeRead);
            if (results.length >= maxResults) return;
            const names = yield* fileSystem.readDirectory(directory).pipe(
              Effect.mapError(mapIo(directory, "list")),
            );
            for (const name of names.sort()) {
              if (results.length >= maxResults) return;
              yield* runGuard(beforeRead);
              const path = paths.join(directory, name);
              const kind = yield* entryType(path);
              if (kind === "SymbolicLink") continue;
              const relativePath = `${prefix}/${name}`;
              if (kind === "Directory") yield* walk(path, relativePath);
              else if (kind === "File" && name.endsWith(".md")) {
                results.push(relativePath);
              }
            }
          });
        yield* walk(base, "topics");
        return results.sort();
      });

    const ensureLayout = (options: MemoryReadOptions = {}) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        yield* ensureSafeDirectory(root, options.beforeRead);
        yield* runGuard(options.beforeRead);
        yield* ensureSafeDirectory(paths.join(root, "topics"), options.beforeRead);
        yield* runGuard(options.beforeRead);
        const index = paths.join(root, INDEX_NAME);
        const inspected = yield* entryType(index).pipe(Effect.result);
        yield* runGuard(options.beforeRead);
        if (Result.isFailure(inspected)) {
          if (platformTag(inspected.failure.cause) !== "NotFound") {
            return yield* inspected.failure;
          }
          yield* atomicWrite(index, EMPTY_INDEX, options);
          return;
        }
        if (inspected.success === "SymbolicLink") {
          return yield* failStore(
            "unsafe_path",
            `${index} must not be a symbolic link`,
            index,
          );
        }
        if (inspected.success !== "File") {
          return yield* failStore(
            "unsafe_path",
            `${index} must be a regular file`,
            index,
          );
        }
      });

    const readTopic = (
      relativePath: string,
      options: MemoryReadOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        const path = yield* resolveMemoryPath(relativePath, options);
        yield* runGuard(options.beforeRead);
        const bounded = yield* readUtf8Prefix(
          path,
          policy.maxTopicBytes,
          options.beforeRead,
        );
        const canonical = yield* canonicalTopicPath(relativePath);
        if (bounded.truncated) {
          return yield* failStore(
            "limit_exceeded",
            `${canonical} exceeds the ${policy.maxTopicBytes}-byte topic limit`,
            canonical,
          );
        }
        const parsed = yield* parseTopicFile(bounded.text).pipe(
          Effect.mapError((cause) =>
            storeError("invalid_topic", cause.message, cause, canonical)
          ),
        );
        return {
          ...parsed,
          relativePath: canonical,
          bytes: Buffer.byteLength(bounded.text),
        } satisfies StoredTopic;
      });

    const listTopics = (options: MemoryReadOptions = {}) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        yield* ensureLayout(options);
        yield* runGuard(options.beforeRead);
        const topics: StoredTopic[] = [];
        for (const relativePath of yield* topicPaths(options.beforeRead)) {
          topics.push(yield* readTopic(relativePath, options));
        }
        return topics.sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        );
      });

    const readStartupContext = (options: MemoryReadOptions = {}) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        yield* ensureLayout(options);
        yield* runGuard(options.beforeRead);
        const degraded: string[] = [];
        let index = "";
        const indexRead = yield* Effect.gen(function*() {
          yield* runGuard(options.beforeRead);
          return yield* readUtf8Prefix(
            paths.join(root, INDEX_NAME),
            policy.maxIndexBytes,
            options.beforeRead,
          );
        }).pipe(Effect.result);
        if (Result.isFailure(indexRead)) {
          if (indexRead.failure.code === "guard_failed") {
            return yield* indexRead.failure;
          }
          degraded.push(memoryReadError(INDEX_NAME, indexRead.failure));
        } else {
          const rawIndex = indexRead.success.text;
          if (indexRead.success.truncated) {
            degraded.push(
              `MEMORY.md exceeds the ${policy.maxIndexBytes}-byte loading limit`,
            );
          }
          const lines = rawIndex.endsWith("\n")
            ? rawIndex.slice(0, -1).split("\n")
            : rawIndex.split("\n");
          const lineLimitExceeded = lines.length > policy.maxIndexLines;
          if (lineLimitExceeded) {
            degraded.push(
              `MEMORY.md exceeds the ${policy.maxIndexLines}-line loading limit`,
            );
          }
          index = lines.slice(0, policy.maxIndexLines).join("\n");
          if (rawIndex.endsWith("\n") || lineLimitExceeded) index += "\n";
          if (Buffer.byteLength(index) > policy.maxIndexBytes) {
            if (!indexRead.success.truncated) {
              degraded.push(
                `MEMORY.md exceeds the ${policy.maxIndexBytes}-byte loading limit`,
              );
            }
            index = truncateUtf8(index, policy.maxIndexBytes);
          }
        }

        const discovered = yield* topicPaths(
          options.beforeRead,
          policy.maxTopicFiles + 1,
        );
        const topicLimitExceeded = discovered.length > policy.maxTopicFiles;
        const topics: StoredTopic[] = [];
        for (const relativePath of discovered.slice(0, policy.maxTopicFiles)) {
          const topic = yield* readTopic(relativePath, options).pipe(Effect.result);
          if (Result.isFailure(topic)) {
            if (topic.failure.code === "guard_failed") return yield* topic.failure;
            degraded.push(memoryReadError(relativePath, topic.failure));
          } else topics.push(topic.success);
        }
        if (topicLimitExceeded) {
          degraded.push(
            `${discovered.length} topics exceed the ${policy.maxTopicFiles}-topic limit`,
          );
        }
        const pinned = topics
          .filter(({ metadata }) => metadata.pinned)
          .sort((left, right) =>
            right.metadata.modified.localeCompare(left.metadata.modified) ||
            left.relativePath.localeCompare(right.relativePath)
          );
        if (pinned.length > policy.maxPinnedTopics) {
          degraded.push(
            `${pinned.length} pinned topics exceed the ${policy.maxPinnedTopics}-topic loading limit`,
          );
        }
        return {
          index,
          pinned: pinned.slice(0, policy.maxPinnedTopics),
          inventory: topics
            .map(({ relativePath, metadata }) => ({
              relativePath,
              type: metadata.type,
              scope: metadata.scope,
              modified: metadata.modified,
              pinned: metadata.pinned,
            }))
            .sort((left, right) =>
              left.relativePath.localeCompare(right.relativePath)
            ),
          degraded,
        } satisfies StartupMemoryContext;
      });

    const writeTopicInternal = (
      topic: TopicWrite,
      existingAllowedOverLimit: boolean,
      options: MemoryMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        yield* ensureLayout(options);
        yield* runGuard(options.beforeRead);
        const relativePath = yield* canonicalTopicPath(topic.relativePath);
        yield* runGuard(options.beforeRead);
        const path = yield* resolveMemoryPath(relativePath, options);
        yield* runGuard(options.beforeRead);
        const exists = yield* fileSystem.exists(path).pipe(
          Effect.mapError(mapIo(path, "inspect")),
        );
        yield* runGuard(options.beforeRead);
        if (!exists) {
          const current = yield* topicPaths(options.beforeRead);
          if (current.length >= policy.maxTopicFiles) {
            return yield* failStore(
              "limit_exceeded",
              `Mate memory has reached its ${policy.maxTopicFiles}-topic limit`,
            );
          }
        } else if (!existingAllowedOverLimit) {
          const current = yield* topicPaths(options.beforeRead);
          if (current.length > policy.maxTopicFiles) {
            return yield* failStore(
              "limit_exceeded",
              `Mate memory exceeds its ${policy.maxTopicFiles}-topic limit`,
            );
          }
        }
        const content = yield* serializeTopicFile({
          metadata: topic.metadata,
          body: topic.body,
        }).pipe(
          Effect.mapError((cause) =>
            storeError("invalid_topic", cause.message, cause, relativePath)
          ),
        );
        if (
          !existingAllowedOverLimit &&
          Buffer.byteLength(content) > policy.maxTopicBytes
        ) {
          return yield* failStore(
            "limit_exceeded",
            `${relativePath} exceeds the ${policy.maxTopicBytes}-byte topic limit`,
            relativePath,
          );
        }
        yield* atomicWrite(path, content, options);
        const parsed = yield* parseTopicFile(content).pipe(
          Effect.mapError((cause) =>
            storeError("invalid_topic", cause.message, cause, relativePath)
          ),
        );
        return {
          ...parsed,
          relativePath,
          bytes: Buffer.byteLength(content),
        } satisfies StoredTopic;
      });

    const writeTopic = (
      topic: TopicWrite,
      options: MemoryMutationOptions = {},
    ) => writeTopicInternal(topic, false, options);

    const validateAndStamp = (
      relativePath: string,
      options: StampOptions = {},
    ) =>
      Effect.gen(function*() {
        const current = yield* readTopic(relativePath, {
          beforeRead: options.beforeRead,
        });
        return yield* writeTopicInternal({
          relativePath: current.relativePath,
          body: current.body,
          metadata: {
            ...current.metadata,
            modified: (options.now ?? new Date()).toISOString(),
          },
        }, !options.enforceTopicLimit, {
          beforeRead: options.beforeRead,
          beforeCommit: options.beforeCommit,
        });
      });

    const deleteTopic = (
      relativePath: string,
      options: MemoryMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        const path = yield* resolveMemoryPath(relativePath, options);
        yield* runGuard(options.beforeRead);
        yield* runGuard(options.beforeCommit);
        yield* fileSystem.remove(path).pipe(
          Effect.mapError(mapIo(path, "delete")),
        );
      });

    const writeIndex = (
      content: string,
      options: MemoryMutationOptions = {},
    ) =>
      Effect.gen(function*() {
        yield* runGuard(options.beforeRead);
        yield* ensureLayout(options);
        yield* runGuard(options.beforeRead);
        yield* atomicWrite(paths.join(root, INDEX_NAME), content, options);
      });

    return {
      root,
      policy,
      ensureLayout,
      readStartupContext,
      listTopics,
      readTopic,
      validateAndStamp,
      writeTopic,
      deleteTopic,
      writeIndex,
      resolveMemoryPath,
    } satisfies MateMemoryStore;
  });
}

export const createMateMemoryStoreEffect = createMateMemoryStore;

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function memoryReadError(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("not valid UTF-8")) return `${path} is not valid UTF-8`;
  return `${path} could not be loaded: ${detail}`;
}
