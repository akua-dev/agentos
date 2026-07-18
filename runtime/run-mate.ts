#!/usr/bin/env bun

import { $ } from "bun";
import { readFile, rename, writeFile } from "node:fs/promises";

type Agent = {
  agent_session?: { kind?: unknown; value?: unknown };
  cwd?: unknown;
  name?: unknown;
  pane_id?: unknown;
};
type AgentList = { result?: { agents?: Agent[] } };

const agentName = requiredEnvironment("AGENTOS_AGENT_NAME");
const agentCwd = requiredEnvironment("AGENTOS_AGENT_CWD");
const session = process.env.HERDR_SESSION ?? `agentos-${agentName}`;

let server: Bun.Subprocess | undefined;
let observer: Bun.Subprocess | undefined;
let stopping = false;

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  server = Bun.spawn(["herdr", "server", "--session", session], {
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  });

  await waitUntilServerReady(server);
  const agents = await listAgents();
  const mates = agents.filter(({ name }) => name === agentName);
  const agentCount = mates.length;

  if (agentCount === 0) {
    await startMate();
  } else if (agentCount === 1) {
    const mate = mates[0]!;
    if (await mateRunsFromCheckout(mate)) {
      await restoreMate();
    } else {
      await relocateMate(mate);
    }
  } else {
    throw new Error(
      `Refusing to start: expected at most one Herdr agent named ${agentName}, found ${agentCount}.`,
    );
  }

  const exitCode = await server.exited;
  server = undefined;
  process.exitCode = exitCode;
} catch (error) {
  await terminate(observer);
  observer = undefined;
  await terminate(server);
  server = undefined;
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function mateRunsFromCheckout(mate: Agent) {
  if (mate.cwd !== agentCwd) return false;
  const persistedSession = mate.agent_session?.value;
  if (mate.agent_session?.kind !== "path" || typeof persistedSession !== "string") {
    return false;
  }
  const { header } = await readPiSession(persistedSession);
  return header.cwd === agentCwd;
}

async function startMate(persistedSession?: string) {
  const command = [
    "herdr",
    "agent",
    "start",
    agentName,
    "--cwd",
    agentCwd,
    "--no-focus",
    "--session",
    session,
    "--",
    "pi",
    ...(persistedSession ? ["--session", persistedSession] : []),
  ];
  await $`${command}`;
}

async function relocateMate(mate: Agent) {
  const paneId = mate.pane_id;
  const persistedSession = mate.agent_session?.value;
  if (
    typeof paneId !== "string" ||
    mate.agent_session?.kind !== "path" ||
    typeof persistedSession !== "string"
  ) {
    throw new Error(
      `Refusing to move ${agentName} from ${String(mate.cwd)} without a persisted Pi session path.`,
    );
  }

  await readPiSession(persistedSession);
  await $`herdr pane close ${paneId} --session ${session}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await mateStatus()) !== 0) {
      await migratePiSessionCwd(persistedSession);
      await startMate(persistedSession);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Herdr did not release ${agentName} after closing pane ${paneId}.`);
}

async function migratePiSessionCwd(path: string) {
  const { contents, header, lineBreak } = await readPiSession(path);
  const next = `${path}.agentos-next`;
  const remainder = lineBreak === -1 ? "\n" : contents.slice(lineBreak);
  await writeFile(
    next,
    `${JSON.stringify({ ...header, cwd: agentCwd })}${remainder}`,
    { mode: 0o600 },
  );
  await rename(next, path);
}

async function readPiSession(path: string) {
  const contents = await readFile(path, "utf8");
  const lineBreak = contents.indexOf("\n");
  const firstLine = lineBreak === -1 ? contents : contents.slice(0, lineBreak);
  const header = JSON.parse(firstLine) as Record<string, unknown>;
  if (header.type !== "session" || typeof header.cwd !== "string") {
    throw new Error(`Refusing to move ${agentName}: ${path} has no valid Pi session header.`);
  }
  return { contents, header, lineBreak };
}

async function waitUntilServerReady(serverProcess: Bun.Subprocess) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Herdr server exited with status ${serverProcess.exitCode}`);
    }
    if ((await herdrStatus()) === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`Herdr session ${session} did not become ready within 30 seconds.`);
}

async function listAgents(): Promise<Agent[]> {
  const result = (await $`herdr agent list --session ${session}`.json()) as AgentList;
  if (!Array.isArray(result.result?.agents)) {
    throw new Error("Herdr returned an invalid agent list.");
  }
  return result.result.agents;
}

async function restoreMate() {
  observer = Bun.spawn(
    [
      "herdr",
      "terminal",
      "session",
      "observe",
      agentName,
      "--cols",
      "120",
      "--rows",
      "40",
      "--session",
      session,
    ],
    { env: process.env, stderr: "ignore", stdout: "ignore" },
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await mateStatus()) === 0) {
      await Bun.sleep(200);
      break;
    }
    await Bun.sleep(100);
  }

  await terminate(observer);
  observer = undefined;
}

async function herdrStatus(): Promise<number> {
  return (
    await $`herdr status --json --session ${session}`.quiet().nothrow()
  ).exitCode;
}

async function mateStatus(): Promise<number> {
  return (
    await $`herdr agent get ${agentName} --session ${session}`.quiet().nothrow()
  ).exitCode;
}

async function terminate(child: Bun.Subprocess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await child.exited;
}

async function stop(exitCode: number) {
  if (stopping) return;
  stopping = true;
  await terminate(observer);
  observer = undefined;
  await terminate(server);
  server = undefined;
  process.exit(exitCode);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for the Mate runtime`);
  return value;
}
