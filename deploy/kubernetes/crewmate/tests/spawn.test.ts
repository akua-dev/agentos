import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCrewmate } from "../spawn.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("co-located Crewmate spawn", () => {
  test("requires explicit approval for the shared Mate security boundary", async () => {
    await expect(
      spawnCrewmate({
        agentId: "30000000-0000-4000-8000-000000000003",
        assignmentId: "50000000-0000-4000-8000-000000000005",
        brief: "/missing/brief.md",
        databaseUrl: "postgresql://runtime_fix_api@postgres/agentos",
        effort: "high",
        handle: "fix-api",
        harness: "codex",
        kind: "ship",
        model: "model",
        project: "/missing/project",
        pgpassFile: "/missing/pgpass",
        releaseRoot: "/missing/release",
        session: "agentos-firstmate",
        taskId: "40000000-0000-4000-8000-000000000004",
      }),
    ).rejects.toThrow(
      "Co-located Crewmates require explicit approval of the shared Mate home and credentials.",
    );
  });

  test("rejects an unreviewed harness before touching the project", async () => {
    await expect(
      spawnCrewmate({
        agentId: "30000000-0000-4000-8000-000000000003",
        assignmentId: "50000000-0000-4000-8000-000000000005",
        brief: "/missing/brief.md",
        databaseUrl: "postgresql://runtime_fix_api@postgres/agentos",
        effort: "high",
        handle: "fix-api",
        harness: "unreviewed" as "codex",
        kind: "ship",
        model: "model",
        project: "/missing/project",
        pgpassFile: "/missing/pgpass",
        releaseRoot: "/missing/release",
        session: "agentos-firstmate",
        taskId: "40000000-0000-4000-8000-000000000004",
        allowSharedHome: true,
      }),
    ).rejects.toThrow("Crewmate harness unreviewed is not a reviewed adapter.");
  });

  test("creates an isolated worktree and starts the reviewed Codex adapter", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-crewmate-spawn-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const project = join(sandbox, "project");
    const worktree = join(sandbox, "treehouse", "fix-api");
    const brief = join(sandbox, "brief.md");
    const releaseRoot = join(sandbox, "release");
    const processLog = join(sandbox, "processes.jsonl");
    const pgpassFile = join(sandbox, "runtime-fix-api.pgpass");
    const bin = join(sandbox, "bin");

    await createProject(project);
    await Promise.all([
      mkdir(join(home, ".codex"), { recursive: true }),
      mkdir(join(home, ".config", "gh"), { recursive: true }),
      mkdir(join(home, ".config", "mise"), { recursive: true }),
      mkdir(join(home, ".local", "share", "mise"), { recursive: true }),
      mkdir(join(home, ".ssh"), { recursive: true }),
    ]);
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Agent\n", "utf8");
    await mkdir(join(releaseRoot, "agents", "crewmate"), { recursive: true });
    await writeFile(
      join(releaseRoot, "agents", "crewmate", "AGENTS.md"),
      "# Crewmate contract\n",
      "utf8",
    );
    await writeFile(brief, "Repair the API and report to the owning Mate.\n", "utf8");
    await writeFile(
      pgpassFile,
      "postgres:5432:agentos:runtime_fix_api:secret\n",
      { mode: 0o600 },
    );
    await createProcessFixtures(bin, processLog);

    const result = await spawnCrewmate(
      {
        allowSharedHome: true,
        agentId: "30000000-0000-4000-8000-000000000003",
        assignmentId: "50000000-0000-4000-8000-000000000005",
        brief,
        databaseUrl: "postgresql://runtime_fix_api@postgres/agentos?sslmode=require",
        effort: "high",
        handle: "fix-api",
        harness: "codex",
        kind: "ship",
        model: "gpt-5.5",
        project,
        pgpassFile,
        releaseRoot,
        session: "agentos-firstmate",
        taskId: "40000000-0000-4000-8000-000000000004",
      },
      {
        ...process.env,
        AGENTOS_DATABASE_URL: "postgresql://runtime_fix_api@postgres/agentos",
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PROCESS_LOG: processLog,
        TREEHOUSE_TEST_WORKTREE: worktree,
      },
    );

    const canonicalProject = await realpath(project);
    const canonicalBrief = await realpath(brief);
    const canonicalHome = await realpath(home);
    const canonicalPgpassFile = await realpath(pgpassFile);
    const canonicalReleaseRoot = await realpath(releaseRoot);
    const canonicalWorktree = await realpath(worktree);
    expect(result).toEqual({
      acquiredLease: true,
      herdrLocator: "agentos-firstmate/fix-api",
      started: true,
      worktree: canonicalWorktree,
    });
    expect(await git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"))
      .toBe(await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    expect(await git(worktree, "rev-parse", "--show-toplevel")).toBe(canonicalWorktree);

    const records = (await readFile(processLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });

    expect(records.map(({ argv }) => argv)).toEqual([
      [
        "mise",
        "install",
        "--locked",
        "github:kunchenguid/treehouse",
        "npm:@openai/codex",
      ],
      ["herdr", "agent", "list", "--session", "agentos-firstmate"],
      ["treehouse", "status"],
      [
        "treehouse",
        "get",
        "--lease",
        "--lease-holder",
        "agentos-30000000-0000-4000-8000-000000000003",
      ],
      [
        "herdr",
        "agent",
        "start",
        "fix-api",
        "--cwd",
        canonicalWorktree,
        "--no-focus",
        "--env",
        "AGENTOS_AGENT_ID=30000000-0000-4000-8000-000000000003",
        "--env",
        "AGENTOS_AGENT_NAME=fix-api",
        "--env",
        "AGENTOS_AGENT_ROLE=crewmate",
        "--env",
        "AGENTOS_ASSIGNMENT_ID=50000000-0000-4000-8000-000000000005",
        "--env",
        `AGENTOS_BRIEF_PATH=${canonicalBrief}`,
        "--env",
        "AGENTOS_DATABASE_URL=postgresql://runtime_fix_api@postgres/agentos?sslmode=require",
        "--env",
        "AGENTOS_PROJECT_ROOT=" + canonicalProject,
        "--env",
        "AGENTOS_RELEASE_ROOT=" + canonicalReleaseRoot,
        "--env",
        "AGENTOS_TASK_ID=40000000-0000-4000-8000-000000000004",
        "--env",
        "AGENTOS_WORK_KIND=ship",
        "--env",
        "MISE_EXPERIMENTAL=1",
        "--env",
        `PGPASSFILE=${canonicalPgpassFile}`,
        "--session",
        "agentos-firstmate",
        "--",
        "mise",
        "exec",
        "--allow-read",
        join(canonicalReleaseRoot, "agents"),
        "--allow-read",
        canonicalBrief,
        "--allow-read",
        canonicalPgpassFile,
        "--allow-write",
        canonicalWorktree,
        "--allow-write",
        join(canonicalProject, ".git"),
        "--allow-write",
        join(canonicalHome, ".codex"),
        "--allow-read",
        join(canonicalHome, ".config", "mise"),
        "--allow-write",
        join(canonicalHome, ".local", "share", "mise"),
        "--allow-read",
        join(canonicalHome, ".config", "gh"),
        "--allow-read",
        join(canonicalHome, ".gitconfig"),
        "--allow-read",
        join(canonicalHome, ".ssh"),
        "--allow-env",
        "AGENTOS_*",
        "--allow-env",
        "CODEX_*",
        "--allow-env",
        "GH_*",
        "--allow-env",
        "GIT_*",
        "--allow-env",
        "MISE_*",
        "--allow-env",
        "PGPASSFILE",
        "--allow-env",
        "SSH_*",
        "--",
        "codex",
        "--model",
        "gpt-5.5",
        "-c",
        'model_reasoning_effort="high"',
        "--dangerously-bypass-approvals-and-sandbox",
        `Read and follow ${join(canonicalReleaseRoot, "agents", "crewmate", "AGENTS.md")} as your AgentOS role contract.\n\nRepair the API and report to the owning Mate.`,
      ],
    ]);
  });
});

async function createProject(project: string) {
  await mkdir(project, { recursive: true });
  await git(project, "init", "--initial-branch=main");
  await git(project, "config", "user.email", "agentos@example.test");
  await git(project, "config", "user.name", "AgentOS test");
  await writeFile(join(project, "README.md"), "# Project\n", "utf8");
  await git(project, "add", "README.md");
  await git(project, "commit", "-m", "Initial commit");
}

async function git(cwd: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

async function createProcessFixtures(bin: string, processLog: string) {
  await mkdir(bin, { recursive: true });
  const fixture = `#!/usr/bin/env bun
const log = process.env.PROCESS_LOG;
if (!log) throw new Error("PROCESS_LOG is required");
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : "") + JSON.stringify({ argv: [Bun.argv[1]?.split("/").at(-1), ...Bun.argv.slice(2)], env: process.env }) + "\\n");
if (Bun.argv[1]?.endsWith("herdr") && Bun.argv[2] === "agent" && Bun.argv[3] === "list") {
  console.log(JSON.stringify({ result: { agents: [] } }));
}
if (Bun.argv[1]?.endsWith("treehouse") && Bun.argv[2] === "get") {
  const worktree = process.env.TREEHOUSE_TEST_WORKTREE;
  if (!worktree) throw new Error("TREEHOUSE_TEST_WORKTREE is required");
  const child = Bun.spawn(["git", "-C", process.cwd(), "worktree", "add", "--detach", worktree, "HEAD"], {
    stderr: "ignore",
    stdout: "ignore",
  });
  if (await child.exited !== 0) process.exit(1);
  console.log(worktree);
}
`;
  await Promise.all(
    ["herdr", "mise", "treehouse"].map(async (name) => {
      const path = join(bin, name);
      await writeFile(path, fixture, "utf8");
      await chmod(path, 0o755);
    }),
  );
  await writeFile(processLog, "", "utf8");
}
