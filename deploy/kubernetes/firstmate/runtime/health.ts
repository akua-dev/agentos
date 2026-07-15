#!/usr/bin/env bun

import { $ } from "bun";

type Agent = { name?: unknown };
type AgentList = { result?: { agents?: Agent[] } };

const session = process.env.HERDR_SESSION ?? "agentos-firstmate";
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
  if (
    !Array.isArray(agents) ||
    agents.filter(({ name }) => name === "firstmate").length !== 1
  ) {
    return 1;
  }

  return (
    await $`herdr agent get firstmate --session ${session}`.quiet().nothrow()
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
