#!/usr/bin/env bun

import { $ } from "bun";

type Agent = { name?: unknown; pane_id?: unknown };
type AgentList = { result?: { agents?: Agent[] } };

const agentName = requiredEnvironment("AGENTOS_AGENT_NAME");
const session = process.env.HERDR_SESSION ?? `agentos-${agentName}`;
const mode = process.argv[2];

if (mode === "live") {
  process.exitCode = (
    await $`herdr status --json --session ${session}`.nothrow()
  ).exitCode;
} else if (mode === "ready") {
  process.exitCode = await readiness();
} else {
  console.error("Usage: health.ts <live|ready>");
  process.exitCode = 2;
}

async function readiness(): Promise<number> {
  if (
    (
      await $`herdr status --json --session ${session}`.quiet().nothrow()
    ).exitCode !== 0
  ) {
    return 1;
  }

  const result = await agentList();
  const agents = result?.result?.agents;
  const matches = Array.isArray(agents)
    ? agents.filter(({ name }) => name === agentName)
    : [];
  if (
    matches.length !== 1 ||
    typeof matches[0]?.pane_id !== "string"
  ) {
    return 1;
  }

  return (
    await $`herdr pane process-info --pane ${matches[0].pane_id} --session ${session}`
      .quiet()
      .nothrow()
  ).exitCode;
}

async function agentList(): Promise<AgentList | undefined> {
  const result = await $`herdr agent list --session ${session}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.toString()) as AgentList;
  } catch {
    return undefined;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for the Mate runtime`);
  return value;
}
