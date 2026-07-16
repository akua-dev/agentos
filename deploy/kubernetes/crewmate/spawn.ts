#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export type SpawnCrewmateOptions = {
  agentId: string;
  allowSharedHome?: boolean;
  assignmentId: string;
  brief: string;
  databaseUrl: string;
  effort: "low" | "medium" | "high" | "xhigh";
  handle: string;
  harness: "codex";
  kind: "ship" | "scout";
  model: string;
  pgpassFile: string;
  project: string;
  releaseRoot: string;
  session: string;
  taskId: string;
};

type SpawnCrewmateResult = {
  acquiredLease: boolean;
  herdrLocator: string;
  started: boolean;
  worktree: string;
};

type HerdrAgent = { name?: unknown };
type HerdrAgentList = { result?: { agents?: HerdrAgent[] } };

export async function spawnCrewmate(
  options: SpawnCrewmateOptions,
  environment: Record<string, string | undefined> = process.env,
): Promise<SpawnCrewmateResult> {
  validate(options);

  const home = await realpath(requiredEnvironment(environment, "HOME"));
  const project = await resolveProjectRoot(options.project, environment);
  const releaseRoot = await realpath(options.releaseRoot);
  const roleContract = join(releaseRoot, "agents", "crewmate", "AGENTS.md");
  await requireFile(roleContract, "Crewmate role contract");
  await requireFile(options.brief, "Crewmate brief");
  await requirePrivateFile(options.pgpassFile, "Crewmate pgpass file");
  const briefPath = await realpath(options.brief);
  const pgpassFile = await realpath(options.pgpassFile);

  const brief = await readFile(briefPath, "utf8");
  if (!brief.trim()) throw new Error("Crewmate brief must not be empty.");

  const codexHome = join(home, ".codex");
  const miseConfig = join(home, ".config", "mise");
  const miseData = join(home, ".local", "share", "mise");
  await Promise.all([
    mkdir(codexHome, { mode: 0o700, recursive: true }),
    mkdir(miseConfig, { mode: 0o700, recursive: true }),
    mkdir(miseData, { mode: 0o700, recursive: true }),
  ]);

  await run(
    [
      "mise",
      "install",
      "--locked",
      "github:kunchenguid/treehouse",
      "npm:@openai/codex",
    ],
    environment,
    releaseRoot,
  );

  const listed = await run(
    ["herdr", "agent", "list", "--session", options.session],
    environment,
  );
  const matches = parseAgentList(listed.stdout).filter(
    ({ name }) => name === options.handle,
  );
  if (matches.length > 1) {
    throw new Error(
      `Herdr session ${options.session} contains more than one Agent named ${options.handle}.`,
    );
  }

  const leaseHolder = `agentos-${options.agentId}`;
  let worktree = await findTreehouseLease(project, leaseHolder, environment);
  let acquiredLease = false;
  if (!worktree) {
    if (matches.length === 1) {
      throw new Error(
        `Herdr Agent ${options.handle} exists without its Treehouse lease; refusing to guess its worktree.`,
      );
    }
    const acquired = await run(
      [
        "treehouse",
        "get",
        "--lease",
        "--lease-holder",
        leaseHolder,
      ],
      environment,
      project,
    );
    const path = acquired.stdout.trim();
    if (!path) throw new Error("Treehouse returned an empty worktree path.");
    worktree = await realpath(expandHome(path, home));
    acquiredLease = true;
  }

  worktree = await realpath(worktree);
  await assertOwnedWorktree(project, worktree, environment);

  let started = false;
  if (matches.length === 0) {
    const prompt =
      `Read and follow ${roleContract} as your AgentOS role contract.\n\n${brief.trimEnd()}`;
    const sandbox = await sandboxArguments({
      briefPath,
      environment,
      home,
      pgpassFile,
      project,
      releaseRoot,
      worktree,
    });
    await run(
      [
        "herdr",
        "agent",
        "start",
        options.handle,
        "--cwd",
        worktree,
        "--no-focus",
        ...agentEnvironment(
          options,
          project,
          briefPath,
          releaseRoot,
          pgpassFile,
        ),
        "--session",
        options.session,
        "--",
        "mise",
        "exec",
        ...sandbox,
        "--",
        "codex",
        "--model",
        options.model,
        "-c",
        `model_reasoning_effort=\"${options.effort}\"`,
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ],
      environment,
    );
    started = true;
  }

  return {
    acquiredLease,
    herdrLocator: `${options.session}/${options.handle}`,
    started,
    worktree,
  };
}

function agentEnvironment(
  options: SpawnCrewmateOptions,
  project: string,
  briefPath: string,
  releaseRoot: string,
  pgpassFile: string,
): string[] {
  return Object.entries({
    AGENTOS_AGENT_ID: options.agentId,
    AGENTOS_AGENT_NAME: options.handle,
    AGENTOS_AGENT_ROLE: "crewmate",
    AGENTOS_ASSIGNMENT_ID: options.assignmentId,
    AGENTOS_BRIEF_PATH: briefPath,
    AGENTOS_DATABASE_URL: options.databaseUrl,
    AGENTOS_PROJECT_ROOT: project,
    AGENTOS_RELEASE_ROOT: releaseRoot,
    AGENTOS_TASK_ID: options.taskId,
    AGENTOS_WORK_KIND: options.kind,
    MISE_EXPERIMENTAL: "1",
    PGPASSFILE: pgpassFile,
  }).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

async function sandboxArguments(options: {
  briefPath: string;
  environment: Record<string, string | undefined>;
  home: string;
  pgpassFile: string;
  project: string;
  releaseRoot: string;
  worktree: string;
}) {
  const arguments_: string[] = [
    "--allow-read",
    join(options.releaseRoot, "agents"),
    "--allow-read",
    options.briefPath,
    "--allow-read",
    options.pgpassFile,
    "--allow-write",
    options.worktree,
    "--allow-write",
    await gitCommonDirectory(options.project, options.environment),
    "--allow-write",
    join(options.home, ".codex"),
    "--allow-read",
    join(options.home, ".config", "mise"),
    "--allow-write",
    join(options.home, ".local", "share", "mise"),
  ];

  for (const path of [
    join(options.home, ".config", "gh"),
    join(options.home, ".gitconfig"),
    join(options.home, ".ssh"),
  ]) {
    if (await exists(path)) arguments_.push("--allow-read", path);
  }

  for (const pattern of [
    "AGENTOS_*",
    "CODEX_*",
    "GH_*",
    "GIT_*",
    "MISE_*",
    "PGPASSFILE",
    "SSH_*",
  ]) {
    arguments_.push("--allow-env", pattern);
  }
  return arguments_;
}

async function findTreehouseLease(
  project: string,
  holder: string,
  environment: Record<string, string | undefined>,
) {
  const status = await run(["treehouse", "status"], environment, project);
  const suffix = `  (held by ${holder})`;
  const matches = status.stdout
    .split("\n")
    .filter((line) => line.endsWith(suffix))
    .map((line) => line.slice(0, -suffix.length).match(/^\S+\s+leased\s+(.+)$/)?.[1])
    .filter((path): path is string => Boolean(path));
  if (matches.length > 1) {
    throw new Error(`Treehouse has more than one lease held by ${holder}.`);
  }
  return matches[0] ? expandHome(matches[0], requiredEnvironment(environment, "HOME")) : undefined;
}

async function resolveProjectRoot(
  project: string,
  environment: Record<string, string | undefined>,
) {
  const root = (
    await run(
      ["git", "-C", project, "rev-parse", "--show-toplevel"],
      environment,
    )
  ).stdout.trim();
  return realpath(root);
}

async function assertOwnedWorktree(
  project: string,
  worktree: string,
  environment: Record<string, string | undefined>,
) {
  const root = await realpath(
    (
      await run(
        ["git", "-C", worktree, "rev-parse", "--show-toplevel"],
        environment,
      )
    ).stdout.trim(),
  );
  if (root === project) {
    throw new Error("Refusing to launch a Crewmate in the primary checkout.");
  }

  const [projectCommonDirectory, worktreeCommonDirectory] = await Promise.all([
    gitCommonDirectory(project, environment),
    gitCommonDirectory(worktree, environment),
  ]);
  if (
    root !== worktree ||
    projectCommonDirectory !== worktreeCommonDirectory
  ) {
    throw new Error("Crewmate worktree does not belong to the selected project.");
  }
}

async function gitCommonDirectory(
  cwd: string,
  environment: Record<string, string | undefined>,
) {
  const directory = (
    await run(
      [
        "git",
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      environment,
    )
  ).stdout.trim();
  return realpath(directory);
}

function parseAgentList(output: string): HerdrAgent[] {
  const result = JSON.parse(output) as HerdrAgentList;
  if (!Array.isArray(result.result?.agents)) {
    throw new Error("Herdr returned an invalid Agent list.");
  }
  return result.result.agents;
}

async function run(
  command: string[],
  environment: Record<string, string | undefined>,
  cwd?: string,
) {
  const invocation = [
    "env",
    "-i",
    ...Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${value}`),
    ...command,
  ];
  let process = $`${invocation}`.quiet().nothrow();
  if (cwd) process = process.cwd(cwd);
  const result = await process;
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const { exitCode } = result;
  if (exitCode !== 0) {
    throw new Error(
      `${command[0]} exited with status ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { stdout };
}

async function requireFile(path: string, label: string) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function requirePrivateFile(path: string, label: string) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function expandHome(path: string, home: string) {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function requiredEnvironment(
  environment: Record<string, string | undefined>,
  name: string,
) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for Crewmate spawn.`);
  return value;
}

function validate(options: SpawnCrewmateOptions) {
  if (options.allowSharedHome !== true) {
    throw new Error(
      "Co-located Crewmates require explicit approval of the shared Mate home and credentials.",
    );
  }
  if (options.harness !== "codex") {
    throw new Error(
      `Crewmate harness ${options.harness} is not a reviewed adapter.`,
    );
  }
  if (!(["ship", "scout"] as readonly string[]).includes(options.kind)) {
    throw new Error(`Crewmate kind ${options.kind} is not supported.`);
  }
  if (!(["low", "medium", "high", "xhigh"] as readonly string[]).includes(options.effort)) {
    throw new Error(`Codex effort ${options.effort} is not supported.`);
  }
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(options.handle) || options.handle.length > 55) {
    throw new Error("Crewmate handle must be a Kubernetes-safe name of at most 55 characters.");
  }
  for (const [label, value] of [
    ["Agent", options.agentId],
    ["Assignment", options.assignmentId],
    ["Task", options.taskId],
  ] as const) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${label} ID must be a UUID.`);
    }
  }
  if (!options.model.trim()) throw new Error("Crewmate model must not be empty.");
  if (!options.session.trim()) throw new Error("Herdr session must not be empty.");

  const databaseUrl = new URL(options.databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname ||
    !databaseUrl.username
  ) {
    throw new Error("Crewmate database URL must identify a PostgreSQL host and login.");
  }
  if (
    databaseUrl.password ||
    [...databaseUrl.searchParams.keys()].some(
      (name) => name.toLowerCase() === "password",
    )
  ) {
    throw new Error("Crewmate database URL must not contain a password; use pgpass.");
  }
}

function parseArguments(argv: string[]): SpawnCrewmateOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Crewmate spawn arguments must use --name value pairs.");
    }
    values.set(name.slice(2), value);
  }

  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const handle = required("handle");

  return {
    agentId: required("agent-id"),
    allowSharedHome: values.get("allow-shared-home") === "true",
    assignmentId: required("assignment-id"),
    brief: required("brief"),
    databaseUrl: required("database-url"),
    effort: required("effort") as SpawnCrewmateOptions["effort"],
    handle,
    harness: required("harness") as SpawnCrewmateOptions["harness"],
    kind: required("kind") as SpawnCrewmateOptions["kind"],
    model: required("model"),
    pgpassFile: required("pgpass-file"),
    project: required("project"),
    releaseRoot: values.get("release-root") ?? process.env.AGENTOS_RELEASE_ROOT ?? "/opt/agentos",
    session: values.get("session") ?? process.env.HERDR_SESSION ?? "agentos-firstmate",
    taskId: required("task-id"),
  };
}

if (import.meta.main) {
  try {
    const result = await spawnCrewmate(parseArguments(Bun.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
