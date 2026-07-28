import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export type MemoryActivityProjection =
  | { kind: "human" | "assistant"; text: string }
  | { kind: "tool"; toolName: string };

export interface CompletedMemorySession {
  sessionId: string;
  completedAt: string;
}

export interface MemoryActivityState {
  version: 1;
  firstSeenAt: string;
  lastDreamDiscoveryAt?: string;
  lastSuccessfulDreamAt?: string;
  completedSessions: CompletedMemorySession[];
}

export interface DreamDecision {
  currentSessionId: string;
  now: Date;
  minHours: number;
  minPriorSessions: number;
}

export type DreamLockClaim =
  | { acquired: false; staleRecovered: false }
  | {
      acquired: true;
      staleRecovered: boolean;
      owner: string;
      token: string;
      startedAt: string;
    };

export interface MemoryActivityOptions {
  now?: () => Date;
  maxFileBytes?: number;
  maxSessionFiles?: number;
  retentionDays?: number;
}

export interface MemoryActivityStore {
  readonly logsRoot: string;
  readonly statePath: string;
  ensureLayout(): Promise<void>;
  append(
    sessionId: string,
    projection: MemoryActivityProjection,
  ): Promise<void>;
  readRecent(days?: number): Promise<string>;
  ensureState(at?: Date): Promise<MemoryActivityState>;
  readState(): Promise<MemoryActivityState>;
  completeSession(sessionId: string, at?: Date): Promise<void>;
  markDreamDiscovery(at?: Date): Promise<void>;
  markDreamSuccess(at?: Date): Promise<void>;
  claimDreamLock(owner: string): Promise<DreamLockClaim>;
  releaseDreamLock(claim: DreamLockClaim): Promise<void>;
}

const DEFAULT_MAX_FILE_BYTES = 32_768;
const DEFAULT_MAX_SESSION_FILES = 64;
const DEFAULT_RETENTION_DAYS = 3;
const MAX_PROJECTION_TEXT = 8_192;
const LOCK_STALE_MS = 60 * 60 * 1_000;

export function createMemoryActivityStore(
  home: string,
  options: MemoryActivityOptions = {},
): MemoryActivityStore {
  const memoryRoot = join(home, "memory");
  const logsRoot = join(memoryRoot, "logs");
  const statePath = join(home, ".local", "state", "agentos", "memory.json");
  const lockPath = join(memoryRoot, ".consolidate-lock");
  const now = options.now ?? (() => new Date());
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSessionFiles =
    options.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

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
  };

  async function ensureLayout() {
    await ensureSafeDirectory(memoryRoot);
    await ensureSafeDirectory(logsRoot);
    const local = join(home, ".local");
    const state = join(local, "state");
    await ensureSafeDirectory(local);
    await ensureSafeDirectory(state);
    await ensureSafeDirectory(dirname(statePath));
  }

  async function append(
    sessionId: string,
    projection: MemoryActivityProjection,
  ) {
    await ensureLayout();
    const at = now();
    const path = projectionPath(logsRoot, sessionId, at);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const line = projectionLine(projection);
    if (!line) return;
    await atomicWrite(path, truncateUtf8(`${current}${line}\n`, maxFileBytes));
    await pruneLogs(at);
  }

  async function readRecent(days = retentionDays): Promise<string> {
    await ensureLayout();
    const cutoff = startOfUtcDay(
      new Date(now().getTime() - Math.max(1, days) * 86_400_000),
    );
    const files = (await activityFiles(logsRoot))
      .filter(({ day }) => day >= cutoff)
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(-maxSessionFiles);
    const parts: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const content = await readFile(file.path, "utf8");
      const remaining = maxFileBytes * Math.min(maxSessionFiles, 8) - bytes;
      if (remaining <= 0) break;
      const bounded = truncateUtf8(content, remaining);
      parts.push(`## ${file.label}\n${bounded}`);
      bytes += Buffer.byteLength(bounded);
    }
    return parts.join("\n");
  }

  async function ensureState(at = now()): Promise<MemoryActivityState> {
    await ensureLayout();
    try {
      return await readState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state: MemoryActivityState = {
        version: 1,
        firstSeenAt: at.toISOString(),
        completedSessions: [],
      };
      await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    }
  }

  async function readState(): Promise<MemoryActivityState> {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    if (!validState(parsed)) {
      throw new Error(`${statePath} contains invalid memory coordination state`);
    }
    return parsed;
  }

  async function completeSession(sessionId: string, at = now()) {
    const state = await ensureState(at);
    const completed = new Map(
      state.completedSessions.map((session) => [
        session.sessionId,
        session,
      ]),
    );
    const existing = completed.get(sessionId);
    const next = { sessionId, completedAt: at.toISOString() };
    if (!existing || existing.completedAt < next.completedAt) {
      completed.set(sessionId, next);
    }
    state.completedSessions = [...completed.values()]
      .sort((left, right) =>
        left.completedAt.localeCompare(right.completedAt),
      )
      .slice(-maxSessionFiles);
    await writeState(state);
  }

  async function markDreamDiscovery(at = now()) {
    const state = await ensureState(at);
    state.lastDreamDiscoveryAt = at.toISOString();
    await writeState(state);
  }

  async function markDreamSuccess(at = now()) {
    const state = await ensureState(at);
    state.lastSuccessfulDreamAt = at.toISOString();
    state.lastDreamDiscoveryAt = at.toISOString();
    await writeState(state);
  }

  async function claimDreamLock(owner: string): Promise<DreamLockClaim> {
    await ensureLayout();
    const startedAt = now().toISOString();
    const token = crypto.randomUUID();
    const claim = {
      acquired: true as const,
      staleRecovered: false,
      owner,
      token,
      startedAt,
    };
    try {
      await writeExclusive(lockPath, claim);
      return claim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readLock(lockPath);
    if (
      existing &&
      now().getTime() - new Date(existing.startedAt).getTime() <= LOCK_STALE_MS
    ) {
      return { acquired: false, staleRecovered: false };
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const recovered = { ...claim, staleRecovered: true };
    try {
      await writeExclusive(lockPath, recovered);
      return recovered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { acquired: false, staleRecovered: false };
      }
      throw error;
    }
  }

  async function releaseDreamLock(claim: DreamLockClaim) {
    if (!claim.acquired) return;
    const existing = await readLock(lockPath);
    if (
      !existing ||
      existing.owner !== claim.owner ||
      existing.token !== claim.token
    ) {
      return;
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function writeState(state: MemoryActivityState) {
    await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async function pruneLogs(at: Date) {
    const cutoff = startOfUtcDay(
      new Date(at.getTime() - retentionDays * 86_400_000),
    );
    const files = (await activityFiles(logsRoot)).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const retained = files.filter(({ day }) => day >= cutoff);
    const remove = [
      ...files.filter(({ day }) => day < cutoff),
      ...retained.slice(0, Math.max(0, retained.length - maxSessionFiles)),
    ];
    await Promise.all(remove.map(({ path }) => rm(path, { force: true })));
  }
}

async function ensureSafeDirectory(path: string) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new Error(`${path} must not be a symbolic link`);
    }
    if (!entry.isDirectory()) throw new Error(`${path} must be a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
  }
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
  ) {
    return false;
  }
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
    .replace(
      /\b(authorization\s*:\s*)bearer\s+\S+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(?:sk|ghp|github_pat|sk-proj|sk-ant|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(
      /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      "$1[REDACTED]@",
    )
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function projectionPath(root: string, sessionId: string, at: Date): string {
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  const day = String(at.getUTCDate()).padStart(2, "0");
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(root, year, month, day, `${digest}.md`);
}

async function activityFiles(root: string): Promise<
  Array<{ path: string; label: string; day: number }>
> {
  const results: Array<{ path: string; label: string; day: number }> = [];
  await walk(root, []);
  return results;

  async function walk(directory: string, segments: string[]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const next = [...segments, entry.name];
      if (entry.isDirectory()) await walk(path, next);
      else if (entry.isFile() && next.length === 4 && entry.name.endsWith(".md")) {
        const [year, month, day] = next;
        const parsedDay = Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
        if (Number.isFinite(parsedDay)) {
          results.push({
            path,
            label: next.join("/"),
            day: parsedDay,
          });
        }
      }
    }
  }
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
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

async function writeExclusive(path: string, value: object) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLock(path: string): Promise<
  { owner: string; token: string; startedAt: string } | undefined
> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "owner" in value &&
      typeof value.owner === "string" &&
      "token" in value &&
      typeof value.token === "string" &&
      "startedAt" in value &&
      isoDate(value.startedAt)
    ) {
      return {
        owner: value.owner,
        token: value.token,
        startedAt: value.startedAt,
      };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function validState(value: unknown): value is MemoryActivityState {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "firstSeenAt" in value &&
    isoDate(value.firstSeenAt) &&
    "completedSessions" in value &&
    Array.isArray(value.completedSessions) &&
    value.completedSessions.every(
      (session) =>
        typeof session === "object" &&
        session !== null &&
        "sessionId" in session &&
        typeof session.sessionId === "string" &&
        "completedAt" in session &&
        isoDate(session.completedAt),
    ) &&
    (!("lastDreamDiscoveryAt" in value) ||
      value.lastDreamDiscoveryAt === undefined ||
      isoDate(value.lastDreamDiscoveryAt)) &&
    (!("lastSuccessfulDreamAt" in value) ||
      value.lastSuccessfulDreamAt === undefined ||
      isoDate(value.lastSuccessfulDreamAt))
  );
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
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
