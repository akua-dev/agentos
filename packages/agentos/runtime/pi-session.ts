import {
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PiRuntime = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  "SessionManager" | "SettingsManager"
>;

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
    const { SessionManager, SettingsManager } =
      await loadPiRuntime(environment);
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

export async function findPreparedPiSessionRelocation(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!isAbsolute(cwd)) {
    throw new Error("A relocated Pi session working directory must be absolute.");
  }
  const directory = await resolvePiSessionDirectory(cwd, environment);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  for (const name of names
    .filter((candidate) => candidate.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 32)) {
    const path = join(directory, name);
    const header = await readPiSessionHeaderPrefix(path);
    if (
      header?.cwd === cwd &&
      typeof header.parentSession === "string" &&
      isAbsolute(header.parentSession)
    ) {
      return path;
    }
  }
  return undefined;
}

const piPackageName = "@earendil-works/pi-coding-agent";
const supportedPiVersion = "0.81.1";
let piRuntimePromise: Promise<PiRuntime> | undefined;

function loadPiRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<PiRuntime> {
  piRuntimePromise ??= resolvePiRuntime(environment);
  return piRuntimePromise;
}

async function resolvePiRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<PiRuntime> {
  let entrypoint: string | undefined;
  try {
    entrypoint = fileURLToPath(import.meta.resolve(piPackageName));
  } catch {
    const child = Bun.spawn(["mise", "which", "pi"], {
      cwd: environment.AGENTOS_RELEASE_ROOT || process.cwd(),
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const executable = stdout.trim();
    if (exitCode !== 0 || !isAbsolute(executable)) {
      throw new Error(
        "Could not locate the installed Pi package through Mise.",
      );
    }
    entrypoint = await findPiPackageEntrypoint(await realpath(executable));
  }

  const packageEntrypoint =
    await findPiPackageEntrypoint(await realpath(entrypoint));
  const runtime = await import(pathToFileURL(packageEntrypoint).href) as
    Partial<PiRuntime>;
  if (
    typeof runtime.SessionManager !== "function" ||
    typeof runtime.SettingsManager !== "function"
  ) {
    throw new Error(
      `${piPackageName}@${supportedPiVersion} does not expose its session runtime.`,
    );
  }
  return runtime as PiRuntime;
}

async function resolvePiSessionDirectory(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    const { SessionManager, SettingsManager } =
      await loadPiRuntime(environment);
    const settings = SettingsManager.create(
      cwd,
      environment.PI_CODING_AGENT_DIR || undefined,
    );
    const manager = SessionManager.create(
      cwd,
      environment.PI_CODING_AGENT_SESSION_DIR ||
        settings.getSessionDir(),
    );
    return resolve(
      cwd,
      manager.getSessionDir(),
    );
  } finally {
    process.chdir(previousCwd);
  }
}

async function findPiPackageEntrypoint(path: string): Promise<string> {
  let directory = dirname(path);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (manifest.name === piPackageName) {
        if (manifest.version !== supportedPiVersion) {
          throw new Error(
            `Expected ${piPackageName}@${supportedPiVersion}, received ${String(manifest.version)}.`,
          );
        }
        return join(directory, "dist", "index.js");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Could not resolve ${piPackageName}@${supportedPiVersion} from ${path}.`,
  );
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

async function readPiSessionHeaderPrefix(
  path: string,
): Promise<PiSessionContents["header"] | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of contents.split("\n")) {
      const candidate = parsePiSessionHeaderCandidate(line);
      if (candidate.kind === "header") return candidate.header;
      if (candidate.kind === "invalid") return undefined;
    }
    return undefined;
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

class InvalidPiSessionHeaderError extends Error {
  constructor(path: string) {
    super(`${path} has no valid Pi session header.`);
    this.name = "InvalidPiSessionHeaderError";
  }
}
