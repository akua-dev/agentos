import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

async function discoveredCommands(
  role: "firstmate" | "secondmate",
) {
  const agentDirectory = await mkdtemp(join(tmpdir(), `agentos-pi-${role}-`));
  temporaryDirectories.push(agentDirectory);
  const child = Bun.spawn(
    [
      resolve(import.meta.dir, "../../../../../node_modules/.bin/pi"),
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--approve",
    ],
    {
      cwd: resolve(
        import.meta.dir,
        `../../../resources/roles/${role}`,
      ),
      env: {
        ...process.env,
        AGENTOS_AGENT_ROLE:
          role === "firstmate" ? "first_mate" : "second_mate",
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

describe("Pi distribution background task discovery", () => {
  for (const role of ["firstmate", "secondmate"] as const) {
    test(`${role} loads the packaged AgentOS background task behavior`, async () => {
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
