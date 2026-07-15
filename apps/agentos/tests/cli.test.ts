import { describe, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { homedir } from "node:os";
import { join } from "node:path";

const app = new URL("..", import.meta.url).pathname;
const entrypoint = join(app, "src/main.ts");
const displayedEntrypoint = entrypoint.startsWith(homedir())
  ? `~${entrypoint.slice(homedir().length)}`
  : entrypoint;

async function runCli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

describe("AgentOS CLI skeleton", () => {
  test("prints an AXI home view when called without arguments", async () => {
    const result = await runCli();

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toEqual({
      bin: displayedEntrypoint,
      description: "Inspect and operate deterministic AgentOS fleet primitives",
      release: "0.0.0",
      implementation: "skeleton",
      help: [
        "Run `agentos --help` to inspect implemented commands",
        "Run `agentos update --check` to inspect release ownership",
      ],
    });
    expect(result.stderr).toBe("");
  });

  test("prints concise command help", async () => {
    const result = await runCli("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`AgentOS fleet primitives

Usage:
  agentos
  agentos update --check
  agentos --help

Commands:
  update --check  Report the immutable release that owns this installation
`);
    expect(result.stderr).toBe("");
  });

  test("keeps updates bound to reviewed AgentOS releases", async () => {
    const result = await runCli("update", "--check");

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toEqual({
      update: {
        managed_by: "AgentOS immutable release",
        current: "0.0.0",
        available: "release metadata not configured",
      },
      help: ["Select and approve a reviewed AgentOS release before upgrading"],
    });
    expect(result.stderr).toBe("");
  });

  test("fails closed with a structured error for unknown commands", async () => {
    const result = await runCli("bootstrap");

    expect(result.exitCode).toBe(2);
    expect(decode(result.stdout)).toEqual({
      error: "Unknown command: bootstrap",
      code: "VALIDATION_ERROR",
      help: ["Run `--help` to see available commands"],
    });
    expect(result.stderr).toBe("");
  });
});
