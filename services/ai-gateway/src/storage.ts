import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { z } from "zod";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export class StoreValidationError extends Error {
  override readonly name = "StoreValidationError";

  constructor(path: string, cause?: unknown) {
    super(`Persisted data at ${path} is invalid`, { cause });
  }
}

export class StoreLockTimeoutError extends Error {
  override readonly name = "StoreLockTimeoutError";

  constructor(path: string, cause?: unknown) {
    super(`Timed out acquiring the state lock for ${path}`, { cause });
  }
}

export interface StoreInspection {
  exists: boolean;
  valid: boolean;
  mode?: number;
}

export interface AtomicJsonStore<T> {
  read(): Promise<T>;
  update(mutator: (current: T) => T | Promise<T>): Promise<T>;
  inspect(): Promise<StoreInspection>;
}

export interface AtomicJsonStoreOptions<T> {
  path: string;
  schema: z.ZodType<T>;
  createDefault: () => T;
  lockTimeoutMs?: number;
}

export function createAtomicJsonStore<T>(options: AtomicJsonStoreOptions<T>): AtomicJsonStore<T> {
  const withLock = async <R>(operation: () => Promise<R>): Promise<R> => {
    await ensurePrivateParent(options.path);
    const target = `${options.path}.lock-target`;
    const targetHandle = await open(target, "a", FILE_MODE);
    await targetHandle.close();
    await chmod(target, FILE_MODE);
    const deadline = Date.now() + (options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        const release = await lockfile.lock(target, {
          realpath: false,
          stale: 30_000,
          update: 10_000,
        });
        try {
          return await operation();
        } finally {
          await release();
        }
      } catch (error) {
        if (!isLockContention(error)) {
          throw error;
        }
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(10, remaining));
      }
    }
    throw new StoreLockTimeoutError(options.path, lastError);
  };

  const readOrCreate = async (): Promise<T> => {
    try {
      await chmod(options.path, FILE_MODE);
      return await readValidated(options.path, options.schema);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const initial = validate(options.path, options.schema, options.createDefault());
    await writeAtomic(options.path, initial);
    return initial;
  };

  return {
    read: () => withLock(readOrCreate),
    update: (mutator) =>
      withLock(async () => {
        const current = await readOrCreate();
        const next = validate(options.path, options.schema, await mutator(current));
        await writeAtomic(options.path, next);
        return next;
      }),
    inspect: async () => {
      try {
        const metadata = await stat(options.path);
        await readValidated(options.path, options.schema);
        return { exists: true, valid: true, mode: metadata.mode & 0o777 };
      } catch (error) {
        if (isMissingFile(error)) return { exists: false, valid: false };
        if (error instanceof StoreValidationError) {
          const metadata = await stat(options.path);
          return { exists: true, valid: false, mode: metadata.mode & 0o777 };
        }
        throw error;
      }
    },
  };
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(parent, DIRECTORY_MODE);
}

async function readValidated<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) throw error;
    throw new StoreValidationError(path, error);
  }
  return validate(path, schema, value);
}

function validate<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new StoreValidationError(path, result.error);
  return result.data;
}

async function writeAtomic<T>(path: string, value: T): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", FILE_MODE);
    temporaryExists = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    temporaryExists = false;
    await chmod(path, FILE_MODE);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isLockContention(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EPERM")
  );
}
