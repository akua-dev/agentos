import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  relativePath: string;
  metadata: TopicMetadata;
  body: string;
}

export interface StoredTopic extends ParsedTopic {
  relativePath: string;
  bytes: number;
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
  beforeRead?: () => void | Promise<void>;
  beforeCommit?: () => void;
}

export interface StampOptions extends MemoryReadOptions {
  now?: Date;
  enforceTopicLimit?: boolean;
}

export interface MemoryMutationOptions extends MemoryReadOptions {}

export interface MateMemoryStore {
  readonly root: string;
  readonly policy: MateMemoryPolicy;
  ensureLayout(options?: MemoryReadOptions): Promise<void>;
  readStartupContext(options?: MemoryReadOptions): Promise<StartupMemoryContext>;
  listTopics(options?: MemoryReadOptions): Promise<StoredTopic[]>;
  readTopic(
    relativePath: string,
    options?: MemoryReadOptions,
  ): Promise<StoredTopic>;
  validateAndStamp(
    relativePath: string,
    options?: StampOptions,
  ): Promise<StoredTopic>;
  writeTopic(
    topic: TopicWrite,
    options?: MemoryMutationOptions,
  ): Promise<StoredTopic>;
  deleteTopic(
    relativePath: string,
    options?: MemoryMutationOptions,
  ): Promise<void>;
  writeIndex(
    content: string,
    options?: MemoryMutationOptions,
  ): Promise<void>;
  resolveMemoryPath(relativePath: string): Promise<string>;
}

const INDEX_NAME = "MEMORY.md";
const EMPTY_INDEX = "# Memory index\n";

export function createMateMemoryStore(
  home: string,
  overrides: Partial<MateMemoryPolicy> = {},
): MateMemoryStore {
  const root = resolve(home, "memory");
  const policy = resolveMateMemoryPolicy(overrides);

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
  };

  async function ensureLayout(options: MemoryReadOptions = {}) {
    await runReadGuard(options.beforeRead);
    await ensureSafeDirectory(root, options.beforeRead);
    await runReadGuard(options.beforeRead);
    await ensureSafeDirectory(join(root, "topics"), options.beforeRead);
    await runReadGuard(options.beforeRead);
    const index = join(root, INDEX_NAME);
    await runReadGuard(options.beforeRead);
    try {
      const entry = await lstat(index);
      await runReadGuard(options.beforeRead);
      if (entry.isSymbolicLink()) {
        throw new Error(`${index} must not be a symbolic link`);
      }
      if (!entry.isFile()) throw new Error(`${index} must be a regular file`);
    } catch (error) {
      if (error instanceof MemoryReadGuardError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await runReadGuard(options.beforeRead);
      await atomicWrite(index, EMPTY_INDEX, options);
    }
  }

  async function readStartupContext(
    options: MemoryReadOptions = {},
  ): Promise<StartupMemoryContext> {
    await runReadGuard(options.beforeRead);
    await ensureLayout(options);
    await runReadGuard(options.beforeRead);
    const degraded: string[] = [];
    let index = "";
    try {
      await runReadGuard(options.beforeRead);
      const boundedIndex = await readUtf8Prefix(
        join(root, INDEX_NAME),
        policy.maxIndexBytes,
        options.beforeRead,
      );
      const rawIndex = boundedIndex.text;
      if (boundedIndex.truncated) {
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
      if (rawIndex.endsWith("\n") || lineLimitExceeded) {
        index += "\n";
      }
      if (Buffer.byteLength(index) > policy.maxIndexBytes) {
        if (!boundedIndex.truncated) {
          degraded.push(
            `MEMORY.md exceeds the ${policy.maxIndexBytes}-byte loading limit`,
          );
        }
        index = truncateUtf8(index, policy.maxIndexBytes);
      }
    } catch (error) {
      if (error instanceof MemoryReadGuardError) throw error;
      degraded.push(memoryReadError(INDEX_NAME, error));
    }

    const topics: StoredTopic[] = [];
    for (const relativePath of await topicPaths(root, options.beforeRead)) {
      try {
        topics.push(await readTopic(relativePath, options));
      } catch (error) {
        if (error instanceof MemoryReadGuardError) throw error;
        degraded.push(memoryReadError(relativePath, error));
      }
    }
    if (topics.length > policy.maxTopicFiles) {
      degraded.push(
        `${topics.length} topics exceed the ${policy.maxTopicFiles}-topic limit`,
      );
    }
    const pinned = topics
      .filter(({ metadata }) => metadata.pinned)
      .sort(
        (left, right) =>
          right.metadata.modified.localeCompare(left.metadata.modified) ||
          left.relativePath.localeCompare(right.relativePath),
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
          left.relativePath.localeCompare(right.relativePath),
        ),
      degraded,
    };
  }

  async function listTopics(
    options: MemoryReadOptions = {},
  ): Promise<StoredTopic[]> {
    await runReadGuard(options.beforeRead);
    await ensureLayout(options);
    await runReadGuard(options.beforeRead);
    const topics: StoredTopic[] = [];
    for (const relativePath of await topicPaths(root, options.beforeRead)) {
      topics.push(await readTopic(relativePath, options));
    }
    return topics.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  async function readTopic(
    relativePath: string,
    options: MemoryReadOptions = {},
  ): Promise<StoredTopic> {
    await runReadGuard(options.beforeRead);
    const path = await resolveMemoryPath(relativePath);
    await runReadGuard(options.beforeRead);
    const bounded = await readUtf8Prefix(
      path,
      policy.maxTopicBytes,
      options.beforeRead,
    );
    if (bounded.truncated) {
      throw new Error(
        `${canonicalTopicPath(relativePath)} exceeds the ${policy.maxTopicBytes}-byte topic limit`,
      );
    }
    const content = bounded.text;
    const parsed = parseTopicFile(content);
    return {
      ...parsed,
      relativePath: canonicalTopicPath(relativePath),
      bytes: Buffer.byteLength(content),
    };
  }

  async function validateAndStamp(
    relativePath: string,
    options: StampOptions = {},
  ): Promise<StoredTopic> {
    const current = await readTopic(relativePath, {
      beforeRead: options.beforeRead,
    });
    const next: TopicWrite = {
      relativePath: current.relativePath,
      body: current.body,
      metadata: {
        ...current.metadata,
        modified: (options.now ?? new Date()).toISOString(),
      },
    };
    return writeTopicInternal(next, !options.enforceTopicLimit, {
      beforeRead: options.beforeRead,
      beforeCommit: options.beforeCommit,
    });
  }

  async function writeTopic(
    topic: TopicWrite,
    options: MemoryMutationOptions = {},
  ): Promise<StoredTopic> {
    return writeTopicInternal(topic, false, options);
  }

  async function writeTopicInternal(
    topic: TopicWrite,
    existingAllowedOverLimit: boolean,
    options: MemoryMutationOptions = {},
  ): Promise<StoredTopic> {
    await runReadGuard(options.beforeRead);
    await ensureLayout(options);
    await runReadGuard(options.beforeRead);
    const relativePath = canonicalTopicPath(topic.relativePath);
    await runReadGuard(options.beforeRead);
    const path = await resolveMemoryPath(relativePath);
    await runReadGuard(options.beforeRead);
    const exists = await pathExists(path);
    await runReadGuard(options.beforeRead);
    if (!exists) {
      const current = await topicPaths(root, options.beforeRead);
      if (current.length >= policy.maxTopicFiles) {
        throw new Error(
          `Mate memory has reached its ${policy.maxTopicFiles}-topic limit`,
        );
      }
    } else if (!existingAllowedOverLimit) {
      const current = await topicPaths(root, options.beforeRead);
      if (current.length > policy.maxTopicFiles) {
        throw new Error(
          `Mate memory exceeds its ${policy.maxTopicFiles}-topic limit`,
        );
      }
    }
    const content = serializeTopicFile({
      metadata: topic.metadata,
      body: topic.body,
    });
    if (
      !existingAllowedOverLimit &&
      Buffer.byteLength(content) > policy.maxTopicBytes
    ) {
      throw new Error(
        `${relativePath} exceeds the ${policy.maxTopicBytes}-byte topic limit`,
      );
    }
    await atomicWrite(path, content, options);
    return {
      ...parseTopicFile(content),
      relativePath,
      bytes: Buffer.byteLength(content),
    };
  }

  async function deleteTopic(
    relativePath: string,
    options: MemoryMutationOptions = {},
  ) {
    await runReadGuard(options.beforeRead);
    const path = await resolveMemoryPath(relativePath);
    await runReadGuard(options.beforeRead);
    options.beforeCommit?.();
    await unlink(path);
  }

  async function writeIndex(
    content: string,
    options: MemoryMutationOptions = {},
  ) {
    await runReadGuard(options.beforeRead);
    await ensureLayout(options);
    await runReadGuard(options.beforeRead);
    if (typeof content !== "string") {
      throw new Error("MEMORY.md content must be text");
    }
    await atomicWrite(join(root, INDEX_NAME), content, options);
  }

  async function resolveMemoryPath(relativePath: string): Promise<string> {
    const normalized =
      relativePath === INDEX_NAME ? INDEX_NAME : canonicalTopicPath(relativePath);
    if (isAbsolute(normalized)) throw new Error("memory path must be relative");
    const path = resolve(root, normalized);
    const fromRoot = relative(root, path);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("memory path escapes the Mate memory root");
    }
    await rejectSymlinkTraversal(root, path);
    return path;
  }
}

function canonicalTopicPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    !normalized.startsWith("topics/") ||
    normalized.includes("/../") ||
    normalized.includes("/./") ||
    normalized.endsWith("/") ||
    !normalized.endsWith(".md")
  ) {
    throw new Error("topic path must be a relative topics/*.md path");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(segment),
    )
  ) {
    throw new Error(
      "topic path must use lowercase safe segments beneath topics/",
    );
  }
  return normalized;
}

async function topicPaths(
  root: string,
  beforeRead?: () => void | Promise<void>,
): Promise<string[]> {
  const base = join(root, "topics");
  const results: string[] = [];
  await walk(base, "topics");
  return results.sort();

  async function walk(directory: string, prefix: string): Promise<void> {
    await runReadGuard(beforeRead);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relativePath);
      }
    }
  }
}

class MemoryReadGuardError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MemoryReadGuardError";
  }
}

async function runReadGuard(
  guard?: () => void | Promise<void>,
): Promise<void> {
  try {
    await guard?.();
  } catch (error) {
    throw new MemoryReadGuardError(error);
  }
}

async function rejectSymlinkTraversal(root: string, target: string) {
  await ensureSafeDirectory(root);
  const rootReal = await realpath(root);
  const fromRoot = relative(root, target);
  let cursor = root;
  const segments = fromRoot.split(sep);
  for (const [index, segment] of segments.entries()) {
    const isLeaf = index === segments.length - 1;
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error(`memory path crosses symbolic link ${cursor}`);
      }
      if (!isLeaf && !entry.isDirectory()) {
        throw new Error(`memory path parent is not a directory: ${cursor}`);
      }
      if (isLeaf && !entry.isFile()) {
        throw new Error(`memory path must be a regular file: ${cursor}`);
      }
      const actual = await realpath(cursor);
      if (
        actual !== rootReal &&
        !actual.startsWith(`${rootReal}${sep}`)
      ) {
        throw new Error("memory path escapes through a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (isLeaf) break;
        await mkdir(cursor, { mode: 0o700 });
        continue;
      }
      throw error;
    }
  }
}

async function ensureSafeDirectory(
  path: string,
  beforeRead?: () => void | Promise<void>,
) {
  await runReadGuard(beforeRead);
  try {
    const entry = await lstat(path);
    await runReadGuard(beforeRead);
    if (entry.isSymbolicLink()) {
      throw new Error(`${path} must not be a symbolic link`);
    }
    if (!entry.isDirectory()) throw new Error(`${path} must be a directory`);
  } catch (error) {
    if (error instanceof MemoryReadGuardError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await runReadGuard(beforeRead);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await runReadGuard(beforeRead);
  }
}

async function atomicWrite(
  path: string,
  content: string,
  options: MemoryMutationOptions = {},
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.agentos-next-${crypto.randomUUID()}`;
  try {
    const handle = await open(next, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.beforeCommit?.();
    await rename(next, path);
  } catch (error) {
    try {
      await unlink(next);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `Could not clean up failed atomic write for ${path}`,
        );
      }
    }
    throw error;
  }
}

async function readUtf8Prefix(
  path: string,
  maxBytes: number,
  beforeRead?: () => void | Promise<void>,
): Promise<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("memory byte limit must be a positive safe integer");
  }
  await runReadGuard(beforeRead);
  const handle = await open(path, "r");
  try {
    await runReadGuard(beforeRead);
    const contents = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      await runReadGuard(beforeRead);
      const result = await handle.read(
        contents,
        bytesRead,
        contents.length - bytesRead,
        bytesRead,
      );
      await runReadGuard(beforeRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const truncated = bytesRead > maxBytes;
    const prefix = contents.subarray(0, Math.min(bytesRead, maxBytes));
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(prefix, {
          stream: truncated,
        }),
        truncated,
      };
    } catch {
      throw new Error(`${path} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
