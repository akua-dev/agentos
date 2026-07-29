import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type PiSessionContents = {
  contents: string;
  header: Record<string, unknown> & { cwd: string; type: "session" };
  lineBreak: number;
};

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
