import { describe, expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const app = new URL("..", import.meta.url).pathname;
const entrypoint = join(app, "src/main.ts");
const displayedEntrypoint = entrypoint.startsWith(homedir())
  ? `~${entrypoint.slice(homedir().length)}`
  : entrypoint;

async function runCliWithEnv(env: Record<string, string>, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: app,
    env: { ...Bun.env, ...env },
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

function runCli(...args: string[]) {
  return runCliWithEnv({}, ...args);
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
  agentos attach <agent> --context <context>
  agentos update --check
  agentos --help

Commands:
  attach <agent>  Open the agent's live Herdr terminal
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

  test("attaches to the selected agent's live Herdr terminal", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "agentos-kubectl-"));
    const executable = join(fakeBin, "kubectl");
    const invocationLog = join(fakeBin, "invocations.jsonl");
    await writeFile(
      executable,
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";

const args = Bun.argv.slice(2);
await appendFile(Bun.env.KUBECTL_INVOCATIONS!, JSON.stringify(args) + "\\n");

if (args.includes("get") && args.includes("pods")) {
  console.log(JSON.stringify({
    items: [{
      metadata: {
        name: "agentos-firstmate-0",
        annotations: {
          "agentos.akua.dev/container": "firstmate",
          "agentos.akua.dev/herdr-session": "agentos-firstmate",
        },
      },
      status: {
        phase: "Running",
        containerStatuses: [{ name: "firstmate", ready: true }],
      },
    }],
  }));
  process.exit(0);
}

if (args.includes("exec")) process.exit(0);
process.exit(9);
`,
    );
    await chmod(executable, 0o755);

    try {
      const result = await runCliWithEnv(
        {
          KUBECTL_INVOCATIONS: invocationLog,
          PATH: `${fakeBin}:${Bun.env.PATH}`,
        },
        "attach",
        "firstmate",
        "--context",
        "orbstack",
      );

      expect(result.exitCode).toBe(0);
      expect(decode(result.stdout)).toEqual({
        attached: {
          agent: "firstmate",
          container: "firstmate",
          context: "orbstack",
          namespace: "agentos",
          pod: "agentos-firstmate-0",
          session: "agentos-firstmate",
        },
      });
      expect(result.stderr).toBe("");
      expect(
        (await readFile(invocationLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        [
          "--context",
          "orbstack",
          "--namespace",
          "agentos",
          "get",
          "pods",
          "--selector",
          "agentos.akua.dev/agent=firstmate",
          "--output",
          "json",
        ],
        [
          "--context",
          "orbstack",
          "--namespace",
          "agentos",
          "exec",
          "--stdin",
          "--tty",
          "pod/agentos-firstmate-0",
          "--container",
          "firstmate",
          "--",
          "herdr",
          "--session",
          "agentos-firstmate",
        ],
      ]);
    } finally {
      await rm(fakeBin, { force: true, recursive: true });
    }
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
