import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function discoveredCommands(role: "firstmate" | "secondmate") {
  const agentDirectory = await mkdtemp(join(tmpdir(), `agentos-pi-${role}-`));
  temporaryDirectories.push(agentDirectory);
  await writeFile(
    join(agentDirectory, "trust.json"),
    `${JSON.stringify({ [resolve(import.meta.dir, "../../../..")]: true })}\n`,
  );
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-skills",
      "--no-prompt-templates",
    ],
    {
      cwd: resolve(import.meta.dir, `../../../${role}`),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Pi RPC exited ${exitCode}: ${stderr || stdout}`);
  }
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === "commands");
  if (!response?.success) throw new Error(`Pi returned no commands: ${stdout}`);
  return response.data.commands as Array<{ name: string; source: string }>;
}

describe("Pi project-local background task discovery", () => {
  for (const role of ["firstmate", "secondmate"] as const) {
    test(`${role} auto-loads the AgentOS background task extension`, async () => {
      const commands = await discoveredCommands(role);

      expect(commands).toContainEqual(
        expect.objectContaining({
          name: "background-commands",
          source: "extension",
        }),
      );
    });
  }
});
