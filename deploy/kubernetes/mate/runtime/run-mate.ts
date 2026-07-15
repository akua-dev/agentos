#!/usr/bin/env bun

import { $ } from "bun";

type Agent = { name?: unknown };
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
  const agentCount = agents.filter(({ name }) => name === agentName).length;

  if (agentCount === 0) {
    await $`herdr agent start ${agentName} --cwd ${agentCwd} --no-focus --session ${session} -- pi`;
  } else if (agentCount === 1) {
    await restoreMate();
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
