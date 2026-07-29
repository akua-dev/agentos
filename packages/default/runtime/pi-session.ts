import { homedir } from "node:os";
import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export type PiSessionContents = {
  contents: string;
  header: Record<string, unknown> & { cwd: string; type: "session" };
  headerStart: number;
  lineBreak: number;
};

// Pi 0.81.1 uses these bounds while locating the first parsed session entry.
// Keep them aligned with the exact peer dependency so recovery and `pi --session`
// accept the same retained files without loading every history during discovery.
const SESSION_HEADER_READ_BUFFER_SIZE = 4 * 1024;
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

export async function findPiSessionToResume(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const agentDirectory = normalizePiPath(
    environment.PI_CODING_AGENT_DIR ||
      join(environment.HOME || homedir(), ".pi", "agent"),
    environment,
    cwd,
  );
  const environmentSessionDirectory =
    environment.PI_CODING_AGENT_SESSION_DIR;
  const configuredSessionDirectory =
    environmentSessionDirectory ||
    (await piSessionDirectorySetting(cwd, agentDirectory));
  const sessionDirectory =
    !configuredSessionDirectory
      ? join(agentDirectory, "sessions")
      : normalizePiPath(configuredSessionDirectory, environment, cwd);
  const paths = await sessionPaths(sessionDirectory);
  const candidates = [] as Array<{ path: string; cwd: string }>;

  for (const path of paths) {
    try {
      const header = await readPiSessionHeader(path);
      candidates.push({ path, cwd: header.cwd });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        error instanceof InvalidPiSessionHeaderError ||
        error instanceof PiSessionHeaderScanLimitError
      ) {
        continue;
      }
      throw error;
    }
  }

  if (candidates.length === 0) return undefined;
  const normalizedCwd = normalizePiPath(cwd, environment, cwd);
  const matching = candidates.filter(
    (candidate) =>
      candidate.cwd !== "" &&
      normalizePiPath(candidate.cwd, environment, cwd) === normalizedCwd,
  );
  if (matching.length === 1) {
    return matching[0]!.path;
  }
  throw new Error(
    `Refusing to start with ${candidates.length} retained Pi sessions; no unique session matches ${cwd}.`,
  );
}

export async function migratePiSessionCwd(
  path: string,
  cwd: string,
): Promise<void> {
  if (!isAbsolute(cwd)) {
    throw new Error("A migrated Pi session working directory must be absolute.");
  }
  const { contents, header, headerStart, lineBreak } =
    await readPiSession(path);
  const next = `${path}.agentos-next`;
  const remainder = lineBreak === -1 ? "\n" : contents.slice(lineBreak);
  await writeFile(
    next,
    `${contents.slice(0, headerStart)}${JSON.stringify({
      ...header,
      cwd,
    })}${remainder}`,
    { mode: 0o600 },
  );
  await rename(next, path);
}

export async function readPiSession(
  path: string,
): Promise<PiSessionContents> {
  const contents = await readFile(path, "utf8");
  let headerStart = 0;
  while (headerStart <= contents.length) {
    const lineBreak = contents.indexOf("\n", headerStart);
    const line =
      lineBreak === -1
        ? contents.slice(headerStart)
        : contents.slice(headerStart, lineBreak);
    const candidate = parsePiSessionHeaderCandidate(line);
    if (candidate.kind === "header") {
      return {
        contents,
        header: candidate.header,
        headerStart,
        lineBreak,
      };
    }
    if (candidate.kind === "invalid" || lineBreak === -1) break;
    headerStart = lineBreak + 1;
  }
  throw new InvalidPiSessionHeaderError(path);
}

async function readPiSessionHeader(
  path: string,
): Promise<PiSessionContents["header"]> {
  const handle = await open(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
    const lineChunks: string[] = [];
    let scannedBytes = 0;

    while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
      const readLength = Math.min(
        buffer.length,
        MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes,
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        readLength,
        null,
      );
      if (bytesRead === 0) {
        lineChunks.push(decoder.end());
        return requirePiSessionHeader(path, lineChunks.join(""));
      }
      scannedBytes += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let lineStart = 0;
      let newline = chunk.indexOf("\n", lineStart);

      while (newline !== -1) {
        lineChunks.push(chunk.slice(lineStart, newline));
        const candidate = parsePiSessionHeaderCandidate(
          lineChunks.join(""),
        );
        if (candidate.kind === "header") return candidate.header;
        if (candidate.kind === "invalid") {
          throw new InvalidPiSessionHeaderError(path);
        }
        lineChunks.length = 0;
        lineStart = newline + 1;
        newline = chunk.indexOf("\n", lineStart);
      }
      lineChunks.push(chunk.slice(lineStart));
    }

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(probe, 0, probe.length, null);
    if (bytesRead === 0) {
      lineChunks.push(decoder.end());
      return requirePiSessionHeader(path, lineChunks.join(""));
    }
    throw new PiSessionHeaderScanLimitError(path);
  } finally {
    await handle.close();
  }
}

type PiSessionHeaderCandidate =
  | { kind: "header"; header: PiSessionContents["header"] }
  | { kind: "invalid" }
  | { kind: "skip" };

function parsePiSessionHeaderCandidate(
  line: string,
): PiSessionHeaderCandidate {
  if (!line.trim()) return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: "skip" };
  }
  if (!parsed) return { kind: "skip" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const entry = parsed as Record<string, unknown>;
  if (
    entry.type !== "session" ||
    typeof entry.id !== "string" ||
    typeof entry.cwd !== "string"
  ) {
    return { kind: "invalid" };
  }
  return {
    header: entry as PiSessionContents["header"],
    kind: "header",
  };
}

function requirePiSessionHeader(
  path: string,
  line: string,
): PiSessionContents["header"] {
  const candidate = parsePiSessionHeaderCandidate(line);
  if (candidate.kind === "header") return candidate.header;
  throw new InvalidPiSessionHeaderError(path);
}

class InvalidPiSessionHeaderError extends Error {
  constructor(path: string) {
    super(`${path} has no valid Pi session header.`);
    this.name = "InvalidPiSessionHeaderError";
  }
}

class PiSessionHeaderScanLimitError extends Error {
  constructor(path: string) {
    super(
      `Pi session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${path}`,
    );
    this.name = "PiSessionHeaderScanLimitError";
  }
}

async function piSessionDirectorySetting(
  cwd: string,
  agentDirectory: string,
): Promise<string | undefined> {
  const [globalSetting, projectSetting] = await Promise.all([
    readSessionDirectorySetting(join(agentDirectory, "settings.json")),
    readSessionDirectorySetting(join(cwd, ".pi", "settings.json")),
  ]);
  return (projectSetting.defined ? projectSetting : globalSetting).value;
}

type SessionDirectorySetting = {
  defined: boolean;
  value: string | undefined;
};

async function readSessionDirectorySetting(
  path: string,
): Promise<SessionDirectorySetting> {
  try {
    const settings = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings)
    ) {
      throw new Error(`${path} has invalid Pi settings.`);
    }
    if (!Object.hasOwn(settings, "sessionDir")) {
      return { defined: false, value: undefined };
    }
    const sessionDirectory = (
      settings as Record<string, unknown>
    ).sessionDir;
    if (!sessionDirectory) {
      return { defined: true, value: undefined };
    }
    if (typeof sessionDirectory !== "string") {
      throw new Error(`${path} has an invalid Pi sessionDir setting.`);
    }
    return { defined: true, value: sessionDirectory };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) {
      return { defined: false, value: undefined };
    }
    throw error;
  }
}

function normalizePiPath(
  path: string,
  environment: NodeJS.ProcessEnv,
  baseDirectory: string,
): string {
  const home = environment.HOME || homedir();
  const expanded =
    path === "~"
      ? home
      : path.startsWith("~/")
        ? join(home, path.slice(2))
        : path;
  return resolve(
    baseDirectory,
    expanded.startsWith("file://") ? fileURLToPath(expanded) : expanded,
  );
}

async function sessionPaths(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const direct = entries
    .filter((entry) => entry.name.endsWith(".jsonl"))
    .map((entry) => join(directory, entry.name));
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const files = await readdir(join(directory, entry.name));
          return files
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(directory, entry.name, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      }),
  );
  return [...direct, ...nested.flat()];
}
