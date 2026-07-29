import {
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type PiSessionContents = {
  contents: string;
  header: Record<string, unknown> & { cwd: string; type: "session" };
  headerStart: number;
  lineBreak: number;
};

export async function migratePiSessionCwd(
  path: string,
  cwd: string,
): Promise<void> {
  if (!isAbsolute(cwd)) {
    throw new Error("A migrated Pi session working directory must be absolute.");
  }
  const { contents, header, headerStart, lineBreak } =
    await readPiSession(path);
  await writePiSession(
    path,
    contents,
    headerStart,
    lineBreak,
    {
      ...header,
      cwd,
    },
  );
}

export async function preparePiSessionRelocation(
  path: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new Error("A relocated Pi session working directory must be absolute.");
  }
  const source = resolve(path);
  const { contents, header, headerStart, lineBreak } =
    await readPiSession(source);
  const previousCwd = process.cwd();
  let target: string;
  let targetDirectory: string;
  let targetHeader: PiSessionContents["header"];

  try {
    process.chdir(cwd);
    const settings = SettingsManager.create(
      cwd,
      environment.PI_CODING_AGENT_DIR || undefined,
    );
    const sessionDirectory =
      environment.PI_CODING_AGENT_SESSION_DIR ||
      settings.getSessionDir();
    const manager = SessionManager.create(cwd, sessionDirectory);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error("Pi did not allocate a persisted session path.");
    }
    target = resolve(cwd, sessionFile);
    targetDirectory = resolve(cwd, manager.getSessionDir());
    targetHeader = {
      ...header,
      ...manager.getHeader(),
      cwd,
      parentSession: source,
      type: "session",
    };
  } finally {
    process.chdir(previousCwd);
  }

  if (
    resolve(dirname(source)) === targetDirectory &&
    header.cwd === cwd
  ) {
    return source;
  }
  await writePiSession(
    target,
    contents,
    headerStart,
    lineBreak,
    targetHeader,
    true,
  );
  return target;
}

async function writePiSession(
  path: string,
  contents: string,
  headerStart: number,
  lineBreak: number,
  header: PiSessionContents["header"],
  create = false,
): Promise<void> {
  const next = `${path}.agentos-next`;
  const remainder = lineBreak === -1 ? "\n" : contents.slice(lineBreak);
  await writeFile(
    next,
    `${contents.slice(0, headerStart)}${JSON.stringify(header)}${remainder}`,
    { flag: create ? "wx" : "w", mode: 0o600 },
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

class InvalidPiSessionHeaderError extends Error {
  constructor(path: string) {
    super(`${path} has no valid Pi session header.`);
    this.name = "InvalidPiSessionHeaderError";
  }
}
