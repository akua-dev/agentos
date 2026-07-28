import {
  lstat,
  mkdir,
  open,
  readFile,
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

export interface StampOptions {
  now?: Date;
}

export interface MateMemoryStore {
  readonly root: string;
  readonly policy: MateMemoryPolicy;
  ensureLayout(): Promise<void>;
  readStartupContext(): Promise<StartupMemoryContext>;
  listTopics(): Promise<StoredTopic[]>;
  readTopic(relativePath: string): Promise<StoredTopic>;
  validateAndStamp(
    relativePath: string,
    options?: StampOptions,
  ): Promise<StoredTopic>;
  writeTopic(topic: TopicWrite): Promise<StoredTopic>;
  deleteTopic(relativePath: string): Promise<void>;
  writeIndex(content: string): Promise<void>;
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

  async function ensureLayout() {
    await mkdir(join(root, "topics"), { recursive: true, mode: 0o700 });
    const index = join(root, INDEX_NAME);
    try {
      await lstat(index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(index, EMPTY_INDEX);
    }
  }

  async function readStartupContext(): Promise<StartupMemoryContext> {
    await ensureLayout();
    const degraded: string[] = [];
    let index = "";
    try {
      const rawIndex = await readUtf8(join(root, INDEX_NAME));
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
        degraded.push(
          `MEMORY.md exceeds the ${policy.maxIndexBytes}-byte loading limit`,
        );
        index = truncateUtf8(index, policy.maxIndexBytes);
      }
    } catch (error) {
      degraded.push(memoryReadError(INDEX_NAME, error));
    }

    const topics: StoredTopic[] = [];
    for (const relativePath of await topicPaths(root)) {
      try {
        topics.push(await readTopic(relativePath));
      } catch (error) {
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

  async function listTopics(): Promise<StoredTopic[]> {
    await ensureLayout();
    const topics = await Promise.all(
      (await topicPaths(root)).map((relativePath) => readTopic(relativePath)),
    );
    return topics.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  async function readTopic(relativePath: string): Promise<StoredTopic> {
    const path = await resolveMemoryPath(relativePath);
    const content = await readUtf8(path);
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
    const current = await readTopic(relativePath);
    const next: TopicWrite = {
      relativePath: current.relativePath,
      body: current.body,
      metadata: {
        ...current.metadata,
        modified: (options.now ?? new Date()).toISOString(),
      },
    };
    return writeTopicInternal(next, true);
  }

  async function writeTopic(topic: TopicWrite): Promise<StoredTopic> {
    return writeTopicInternal(topic, false);
  }

  async function writeTopicInternal(
    topic: TopicWrite,
    existingAllowedOverLimit: boolean,
  ): Promise<StoredTopic> {
    await ensureLayout();
    const relativePath = canonicalTopicPath(topic.relativePath);
    const path = await resolveMemoryPath(relativePath);
    const exists = await pathExists(path);
    if (!exists || !existingAllowedOverLimit) {
      const current = await topicPaths(root);
      if (!exists && current.length >= policy.maxTopicFiles) {
        throw new Error(
          `Mate memory has reached its ${policy.maxTopicFiles}-topic limit`,
        );
      }
    }
    const content = serializeTopicFile({
      metadata: topic.metadata,
      body: topic.body,
    });
    await atomicWrite(path, content);
    return {
      ...parseTopicFile(content),
      relativePath,
      bytes: Buffer.byteLength(content),
    };
  }

  async function deleteTopic(relativePath: string) {
    const path = await resolveMemoryPath(relativePath);
    await unlink(path);
  }

  async function writeIndex(content: string) {
    await ensureLayout();
    if (typeof content !== "string") {
      throw new Error("MEMORY.md content must be text");
    }
    await atomicWrite(join(root, INDEX_NAME), content);
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

async function topicPaths(root: string): Promise<string[]> {
  const base = join(root, "topics");
  const results: string[] = [];
  await walk(base, "topics");
  return results.sort();

  async function walk(directory: string, prefix: string): Promise<void> {
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

async function rejectSymlinkTraversal(root: string, target: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(root);
  const fromRoot = relative(root, target);
  let cursor = root;
  for (const segment of fromRoot.split(sep).slice(0, -1)) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error(`memory path crosses symbolic link ${cursor}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`memory path parent is not a directory: ${cursor}`);
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
        await mkdir(cursor, { mode: 0o700 });
        continue;
      }
      throw error;
    }
  }
}

async function atomicWrite(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.agentos-next-${crypto.randomUUID()}`;
  const handle = await open(next, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(next, path);
}

async function readUtf8(path: string): Promise<string> {
  const contents = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
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
