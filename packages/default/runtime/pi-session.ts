import { homedir } from "node:os";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { join } from "node:path";

export type PiSessionContents = {
  contents: string;
  header: Record<string, unknown> & { cwd: string; type: "session" };
  lineBreak: number;
};

export async function findPiSessionToResume(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const agentDirectory =
    environment.PI_CODING_AGENT_DIR ??
    join(environment.HOME ?? homedir(), ".pi", "agent");
  const sessionDirectory =
    environment.PI_CODING_AGENT_SESSION_DIR ??
    join(agentDirectory, "sessions");
  const paths = await sessionPaths(sessionDirectory);
  const candidates = [] as Array<{ path: string; cwd: string }>;

  for (const path of paths) {
    try {
      const { header } = await readPiSession(path);
      candidates.push({ path, cwd: header.cwd });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        error instanceof SyntaxError ||
        (error instanceof Error &&
          error.message === `${path} has no valid Pi session header.`)
      ) {
        continue;
      }
      throw error;
    }
  }

  if (candidates.length === 0) return undefined;
  const matching = candidates.filter((candidate) => candidate.cwd === cwd);
  if (candidates.length === 1 && matching.length === 1) {
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
  const { contents, header, lineBreak } = await readPiSession(path);
  const next = `${path}.agentos-next`;
  const remainder = lineBreak === -1 ? "\n" : contents.slice(lineBreak);
  await writeFile(
    next,
    `${JSON.stringify({ ...header, cwd })}${remainder}`,
    { mode: 0o600 },
  );
  await rename(next, path);
}

export async function readPiSession(
  path: string,
): Promise<PiSessionContents> {
  const contents = await readFile(path, "utf8");
  const lineBreak = contents.indexOf("\n");
  const firstLine = lineBreak === -1 ? contents : contents.slice(0, lineBreak);
  const parsed = JSON.parse(firstLine) as Record<string, unknown>;
  if (parsed.type !== "session" || typeof parsed.cwd !== "string") {
    throw new Error(`${path} has no valid Pi session header.`);
  }
  const header = parsed as PiSessionContents["header"];
  return { contents, header, lineBreak };
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
