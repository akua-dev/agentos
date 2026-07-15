#!/usr/bin/env bun

import { $ } from "bun";

type Agent = { name?: unknown };
type AgentList = { result?: { agents?: Agent[] } };

const releaseRoot = withoutTrailingSlash(
  process.env.AGENTOS_RELEASE_ROOT ?? "/opt/agentos",
);
const session = process.env.HERDR_SESSION ?? "agentos-firstmate";
const firstmateCwd =
  process.env.FIRSTMATE_CWD ?? joinPath(releaseRoot, "agents", "firstmate");

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
  const firstmateCount = agents.filter(({ name }) => name === "firstmate").length;

  if (firstmateCount === 0) {
    await $`herdr agent start firstmate --cwd ${firstmateCwd} --no-focus --session ${session} -- pi`;
  } else if (firstmateCount === 1) {
    await restoreFirstMate();
  } else {
    throw new Error(
      `Refusing to start: expected at most one Herdr agent named firstmate, found ${firstmateCount}.`,
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
    if (
      (await herdrStatus()) === 0
    ) {
      return;
    }
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

async function restoreFirstMate() {
  observer = Bun.spawn(
    [
      "herdr",
      "terminal",
      "session",
      "observe",
      "firstmate",
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
    if (
      (await firstmateStatus()) === 0
    ) {
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

async function firstmateStatus(): Promise<number> {
  return (
    await $`herdr agent get firstmate --session ${session}`.quiet().nothrow()
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

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}
