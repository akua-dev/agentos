import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Agent = { name: string };

const repository = new URL("../../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const runtime = new URL("..", import.meta.url).pathname;
const runFirstMate = join(runtime, "runtime", "run-firstmate.ts");
const health = join(runtime, "runtime", "health.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function waitFor(predicate: () => Promise<boolean>, timeout = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for fake Herdr activity");
}

async function createHarness(agents: Agent[]) {
  const sandbox = await mkdtemp(join(tmpdir(), "agentos-firstmate-runtime-"));
  temporaryDirectories.push(sandbox);
  const fakeBin = join(sandbox, "bin");
  const state = join(sandbox, "state");
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  await writeFile(join(state, "agents.json"), JSON.stringify(agents), "utf8");
  const fakeHerdr = join(fakeBin, "herdr");
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env bun
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const state = process.env.FAKE_HERDR_STATE!;
const args = process.argv.slice(2);
await appendFile(join(state, "calls.jsonl"), JSON.stringify(args) + "\\n");
const command = args.slice(0, 2).join(" ");
if (args[0] === "server") {
  await writeFile(join(state, "server-ready"), "ready\\n");
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else if (args[0] === "status") {
  console.log(JSON.stringify({ result: { type: "server_status", running: true } }));
} else if (command === "agent list") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  console.log(JSON.stringify({ result: { type: "agent_list", agents } }));
} else if (command === "agent start") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  agents.push({ name: args[2] });
  await writeFile(join(state, "agents.json"), JSON.stringify(agents));
  console.log(JSON.stringify({ result: { type: "agent_started", name: args[2] } }));
} else if (command === "agent get") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  const agent = agents.find((candidate: { name: string }) => candidate.name === args[2]);
  if (!agent) process.exit(1);
  console.log(JSON.stringify({ result: { type: "agent_info", agent } }));
} else if (args.slice(0, 3).join(" ") === "terminal session observe") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
}
`,
    "utf8",
  );
  await chmod(fakeHerdr, 0o755);

  const env = {
    ...process.env,
    AGENTOS_RELEASE_ROOT: repository,
    FAKE_HERDR_STATE: state,
    HERDR_SESSION: "agentos-firstmate-test",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };

  return { env, state };
}

async function readCalls(state: string): Promise<string[][]> {
  try {
    return (await readFile(join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function runHealth(env: Record<string, string | undefined>, mode: "live" | "ready") {
  const child = Bun.spawn([process.execPath, health, mode], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("First Mate runtime", () => {
  test("starts one named Pi agent on an empty Herdr session", async () => {
    const { env, state } = await createHarness([]);
    const child = Bun.spawn([process.execPath, runFirstMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedStart = [
      "agent",
      "start",
      "firstmate",
      "--cwd",
      join(repository, "agents", "firstmate"),
      "--no-focus",
      "--session",
      "agentos-firstmate-test",
      "--",
      "pi",
      "--model",
      "openai-codex/gpt-5.6-terra",
      "--thinking",
      "high",
    ];

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call.length === expectedStart.length &&
        call.every((argument, index) => argument === expectedStart[index]),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect((await readCalls(state)).filter((call) => call[0] === "agent" && call[1] === "start")).toEqual([
      expectedStart,
    ]);
  });

  test("triggers native restore instead of creating a second First Mate", async () => {
    const { env, state } = await createHarness([{ name: "firstmate" }]);
    const child = Bun.spawn([process.execPath, runFirstMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedObserve = [
      "terminal",
      "session",
      "observe",
      "firstmate",
      "--cols",
      "120",
      "--rows",
      "40",
      "--session",
      "agentos-firstmate-test",
    ];

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call.length === expectedObserve.length &&
        call.every((argument, index) => argument === expectedObserve[index]),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const calls = await readCalls(state);
    expect(calls.filter((call) => call[0] === "agent" && call[1] === "start")).toEqual([]);
    expect(calls.filter((call) => call.slice(0, 3).join(" ") === "terminal session observe")).toEqual([
      expectedObserve,
    ]);
  });

  test("fails closed when persisted identity is ambiguous", async () => {
    const { env, state } = await createHarness([
      { name: "firstmate" },
      { name: "firstmate" },
    ]);
    const child = Bun.spawn([process.execPath, runFirstMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      "Refusing to start: expected at most one Herdr agent named firstmate, found 2.\n",
    );
    expect(
      (await readCalls(state)).filter((call) => call[0] === "agent" && call[1] === "start"),
    ).toEqual([]);
  });

  test("separates server liveness from required-agent readiness", async () => {
    const { env, state } = await createHarness([]);

    expect((await runHealth(env, "live")).exitCode).toBe(0);
    expect((await runHealth(env, "ready")).exitCode).toBe(1);

    await writeFile(join(state, "agents.json"), JSON.stringify([{ name: "firstmate" }]), "utf8");
    expect((await runHealth(env, "ready")).exitCode).toBe(0);
  });
});
