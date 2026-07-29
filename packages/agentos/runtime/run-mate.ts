#!/usr/bin/env bun

import { $ } from "bun";
import { join } from "node:path";

import { resolvePersistentMateDistribution } from "./distribution.ts";
import {
  preparePiSessionRelocation,
  readPiSession,
} from "./pi-session.ts";

type Agent = {
  agent_session?: { kind?: unknown; value?: unknown };
  cwd?: unknown;
  name?: unknown;
  pane_id?: unknown;
};
type AgentList = { result?: { agents?: Agent[] } };

const agentName = requiredEnvironment("AGENTOS_AGENT_NAME");
const { roleDirectory: agentCwd } =
  resolvePersistentMateDistribution(process.env);
const session = process.env.HERDR_SESSION ?? `agentos-${agentName}`;
process.env.NODE_PATH ||= join(
  process.env.AGENTOS_RELEASE_ROOT ?? "/opt/agentos",
  "node_modules",
);

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
      await restoreMate(mate);
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
    "--no-context-files",
    ...(persistedSession ? ["--session", persistedSession] : ["--continue"]),
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

  const relocatedSession = await preparePiSessionRelocation(
    persistedSession,
    agentCwd,
  );
  await $`herdr pane close ${paneId} --session ${session}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await mateStatus()) !== 0) {
      await startMate(relocatedSession);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Herdr did not release ${agentName} after closing pane ${paneId}.`);
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

async function restoreMate(mate: Agent) {
  const paneId = mate.pane_id;
  if (typeof paneId !== "string") {
    throw new Error(`Refusing to restore ${agentName} without a Herdr pane ID.`);
  }
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
    if ((await paneProcessStatus(paneId)) === 0) {
      await terminate(observer);
      observer = undefined;
      return;
    }
    await Bun.sleep(100);
  }

  await terminate(observer);
  observer = undefined;
  await relocateMate(mate);
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

async function paneProcessStatus(paneId: string): Promise<number> {
  return (
    await $`herdr pane process-info --pane ${paneId} --session ${session}`
      .quiet()
      .nothrow()
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
