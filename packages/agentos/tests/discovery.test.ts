import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function discoveredCommandNames(
  role: "first_mate" | "second_mate",
): Promise<string[]> {
  const agentDirectory = await mkdtemp(
    resolve(tmpdir(), `agentos-default-${role}-`),
  );
  temporaryDirectories.push(agentDirectory);
  const roleDirectory = role === "first_mate" ? "firstmate" : "secondmate";
  const cwd = resolve(
    import.meta.dir,
    "..",
    "resources",
    "roles",
    roleDirectory,
  );
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-context-files",
      "--approve",
    ],
    {
      cwd,
      env: {
        ...process.env,
        AGENTOS_AGENT_ROLE: role,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
  );
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
  if (!response?.success) {
    throw new Error(`Pi returned no command catalog: ${stderr || stdout}`);
  }
  return response.data.commands.map(
    ({ name }: { name: string }) => name,
  ) as string[];
}

describe("installed default distribution discovery", () => {
  test("First Mate loads shared and role-only resources through one entrypoint", async () => {
    const commands = await discoveredCommandNames("first_mate");
    expect(commands).toContain("background-commands");
    expect(commands).toContain("memory");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).toContain("skill:agentos-bootstrap");
    expect(commands).toContain("skill:agentos-upgrade");
  });

  test("Second Mate does not receive First-Mate-only Skills", async () => {
    const commands = await discoveredCommandNames("second_mate");
    expect(commands).toContain("background-commands");
    expect(commands).toContain("memory");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).toContain("skill:agentos-upgrade");
    expect(commands).not.toContain("skill:agentos-bootstrap");
    expect(commands).not.toContain("skill:agentos-secondmates");
  });
});
