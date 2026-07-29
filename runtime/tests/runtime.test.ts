import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Agent = {
  agent_session?: { kind: string; value: string };
  cwd?: string;
  live?: boolean;
  name: string;
  pane_id?: string;
};

const repository = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const mateRuntime = join(repository, "runtime");
const runMate = join(mateRuntime, "run-mate.ts");
const health = join(mateRuntime, "health.ts");
const defaultDistributionRoot = join(repository, "packages", "default");
const defaultFirstMateCwd = join(
  defaultDistributionRoot,
  "resources",
  "roles",
  "firstmate",
);
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

async function createHarness(
  agents: Agent[],
  overrides: Record<string, string> = {},
) {
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
  await writeFile(join(state, "server-node-path"), process.env.NODE_PATH ?? "");
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
  const cwdIndex = args.indexOf("--cwd");
  agents.push({
    cwd: args[cwdIndex + 1],
    live: true,
    name: args[2],
    pane_id: "w-started:p1",
  });
  await writeFile(join(state, "agents.json"), JSON.stringify(agents));
  if (process.env.FAKE_PI_EXTENSION) {
    const child = Bun.spawn(["node", process.env.FAKE_PI_EXTENSION], {
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(join(state, "child-stdout"), stdout, "utf8");
    await writeFile(join(state, "child-stderr"), stderr, "utf8");
    if (exitCode !== 0) process.exit(exitCode);
  }
  console.log(JSON.stringify({ result: { type: "agent_started", name: args[2] } }));
} else if (command === "agent get") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  const agent = agents.find((candidate: { name: string }) => candidate.name === args[2]);
  if (!agent) process.exit(1);
  console.log(JSON.stringify({ result: { type: "agent_info", agent } }));
} else if (command === "pane process-info") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  const paneIndex = args.indexOf("--pane");
  const agent = agents.find((candidate: { live?: boolean; pane_id?: string }) =>
    candidate.pane_id === args[paneIndex + 1] && candidate.live,
  );
  if (!agent) process.exit(1);
  console.log(JSON.stringify({ result: { type: "pane_process_info" } }));
} else if (command === "pane close") {
  const agents = JSON.parse(await readFile(join(state, "agents.json"), "utf8"));
  await writeFile(
    join(state, "agents.json"),
    JSON.stringify(agents.filter((candidate: { pane_id?: string }) => candidate.pane_id !== args[2])),
  );
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
    AGENTOS_AGENT_CWD: defaultFirstMateCwd,
    AGENTOS_AGENT_NAME: "firstmate",
    AGENTOS_AGENT_ROLE: "first_mate",
    AGENTOS_DISTRIBUTION_ROOT: defaultDistributionRoot,
    FAKE_HERDR_STATE: state,
    HERDR_SESSION: "agentos-firstmate-test",
    PI_CODING_AGENT_DIR: join(state, "pi-agent"),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    ...overrides,
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

describe("Mate runtime", () => {
  test("starts one named Pi agent on an empty Herdr session", async () => {
    const { env, state } = await createHarness([]);
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedStart = [
      "agent",
      "start",
      "firstmate",
      "--cwd",
      defaultFirstMateCwd,
      "--no-focus",
      "--session",
      "agentos-firstmate-test",
      "--",
      "pi",
      "--no-context-files",
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

  test("resumes the sole native Pi session when Herdr has no agent", async () => {
    const { env, state } = await createHarness([]);
    const persistedSession = join(
      env.PI_CODING_AGENT_DIR!,
      "sessions",
      "--legacy-cwd--",
      "session.jsonl",
    );
    await mkdir(join(env.PI_CODING_AGENT_DIR!, "sessions", "--legacy-cwd--"), {
      recursive: true,
    });
    await writeFile(
      persistedSession,
      `${JSON.stringify({ cwd: env.AGENTOS_AGENT_CWD, id: "session-retained", type: "session", version: 3 })}\n`,
      "utf8",
    );
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedStart = [
      "agent",
      "start",
      "firstmate",
      "--cwd",
      defaultFirstMateCwd,
      "--no-focus",
      "--session",
      "agentos-firstmate-test",
      "--",
      "pi",
      "--no-context-files",
      "--session",
      persistedSession,
    ];

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call.length === expectedStart.length &&
        call.every((argument, index) => argument === expectedStart[index]),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(
      (await readCalls(state)).filter(
        (call) => call[0] === "agent" && call[1] === "start",
      ),
    ).toEqual([expectedStart]);
  });

  test("resumes from Pi's configured session directory with native tilde expansion", async () => {
    const { env, state } = await createHarness([]);
    const home = join(state, "home");
    const sessionDirectory = join(home, "retained-sessions");
    const persistedSession = join(sessionDirectory, "session.jsonl");
    await Promise.all([
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(env.PI_CODING_AGENT_DIR!, "settings.json"),
        `${JSON.stringify({ sessionDir: "~/retained-sessions" })}\n`,
        "utf8",
      ),
      writeFile(
        persistedSession,
        `${JSON.stringify({ cwd: env.AGENTOS_AGENT_CWD, id: "session-configured", type: "session", version: 3 })}\n`,
        "utf8",
      ),
    ]);
    const child = Bun.spawn([process.execPath, runMate], {
      env: {
        ...env,
        HOME: home,
        PI_CODING_AGENT_SESSION_DIR: "",
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call[0] === "agent" &&
        call[1] === "start" &&
        call.includes(persistedSession),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });

  test("resolves Pi's relative session directory from the target Mate cwd", async () => {
    const distributionRoot = await mkdtemp(
      join(tmpdir(), "agentos-relative-distribution-"),
    );
    temporaryDirectories.push(distributionRoot);
    const agentCwd = join(
      distributionRoot,
      "resources",
      "roles",
      "firstmate",
    );
    const { env, state } = await createHarness([], {
      AGENTOS_AGENT_CWD: agentCwd,
      AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
    });
    const sessionDirectory = join(agentCwd, ".pi", "retained-sessions");
    const persistedSession = join(sessionDirectory, "session.jsonl");
    await Promise.all([
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(env.PI_CODING_AGENT_DIR!, "settings.json"),
        `${JSON.stringify({ sessionDir: ".pi/retained-sessions" })}\n`,
        "utf8",
      ),
      writeFile(
        persistedSession,
        `${JSON.stringify({ cwd: agentCwd, id: "session-relative", type: "session", version: 3 })}\n`,
        "utf8",
      ),
    ]);
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call[0] === "agent" &&
        call[1] === "start" &&
        call.includes(persistedSession),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });

  test("resumes when blank and malformed lines precede the native Pi header", async () => {
    const { env, state } = await createHarness([]);
    const sessions = join(env.PI_CODING_AGENT_DIR!, "sessions", "--legacy-cwd--");
    const persistedSession = join(sessions, "session.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      persistedSession,
      [
        "",
        "{malformed",
        "null",
        "false",
        JSON.stringify({
          cwd: env.AGENTOS_AGENT_CWD,
          id: "session-with-preamble",
          type: "session",
          version: 3,
        }),
        JSON.stringify({ message: "preserve me", type: "message" }),
        "",
      ].join("\n"),
      "utf8",
    );
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call[0] === "agent" &&
        call[1] === "start" &&
        call.includes(persistedSession),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });

  test("does not discover a Pi header beyond Pi's bounded one-megabyte scan", async () => {
    const { env, state } = await createHarness([]);
    const sessionDirectory = join(state, "oversized-sessions");
    const persistedSession = join(sessionDirectory, "oversized.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      persistedSession,
      `${"{malformed\n".repeat(100_000)}${JSON.stringify({
        cwd: env.AGENTOS_AGENT_CWD,
        id: "session-beyond-scan-limit",
        type: "session",
        version: 3,
      })}\n`,
      "utf8",
    );
    const child = Bun.spawn([process.execPath, runMate], {
      env: {
        ...env,
        PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call[0] === "agent" &&
        call[1] === "start" &&
        !call.includes(persistedSession),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });

  test("fails closed instead of creating a fresh Pi session when retained sessions are ambiguous", async () => {
    const { env, state } = await createHarness([]);
    const sessions = join(env.PI_CODING_AGENT_DIR!, "sessions", "--legacy-cwd--");
    await mkdir(sessions, { recursive: true });
    await Promise.all(
      ["session-one.jsonl", "session-two.jsonl"].map((name, index) =>
        writeFile(
          join(sessions, name),
          `${JSON.stringify({ cwd: env.AGENTOS_AGENT_CWD, id: `session-${index}`, type: "session", version: 3 })}\n`,
          "utf8",
        ),
      ),
    );
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no unique session matches");
    expect(
      (await readCalls(state)).filter(
        (call) => call[0] === "agent" && call[1] === "start",
      ),
    ).toEqual([]);
  });

  test("gives a persistent checkout access to release-installed dependencies", async () => {
    const releaseRoot = "/opt/agentos-test";
    const { env, state } = await createHarness([], {
      AGENTOS_AGENT_CWD:
        "/home/agent/projects/agentos/packages/default/resources/roles/firstmate",
      AGENTOS_DISTRIBUTION_ROOT:
        "/home/agent/projects/agentos/packages/default",
      AGENTOS_RELEASE_ROOT: releaseRoot,
      NODE_PATH: "",
    });
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () => Bun.file(join(state, "server-ready")).exists());
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await readFile(join(state, "server-node-path"), "utf8")).toBe(
      join(releaseRoot, "node_modules"),
    );
  });

  test("resolves a release dependency from a persistent Pi extension child", async () => {
    const releaseRoot = await mkdtemp(join(tmpdir(), "agentos-release-"));
    temporaryDirectories.push(releaseRoot);
    const dependencyRoot = join(
      releaseRoot,
      "node_modules",
      "release-only-dependency",
    );
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(
      join(dependencyRoot, "package.json"),
      JSON.stringify({ name: "release-only-dependency", main: "index.cjs" }),
      "utf8",
    );
    await writeFile(
      join(dependencyRoot, "index.cjs"),
      "module.exports = { value: 'loaded from release image' };\n",
      "utf8",
    );
    const persistentCheckout = join(releaseRoot, "persistent-checkout");
    const distributionRoot = join(persistentCheckout, "packages", "default");
    const firstMateCwd = join(
      distributionRoot,
      "resources",
      "roles",
      "firstmate",
    );
    const extension = join(
      firstMateCwd,
      ".pi",
      "extensions",
      "agentos-mate-memory.mjs",
    );
    await mkdir(join(firstMateCwd, ".pi", "extensions"), {
      recursive: true,
    });
    await writeFile(
      extension,
      [
        'import { createRequire } from "node:module";',
        'import { writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "const require = createRequire(import.meta.url);",
        "const dependency = require(\"release-only-dependency\");",
        'await writeFile(join(process.env.FAKE_HERDR_STATE, "child-result"), dependency.value, "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );
    const { env, state } = await createHarness([], {
      AGENTOS_AGENT_CWD: firstMateCwd,
      AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
      AGENTOS_RELEASE_ROOT: releaseRoot,
      FAKE_PI_EXTENSION: extension,
      NODE_PATH: "",
    });
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () => Bun.file(join(state, "child-result")).exists());
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await readFile(join(state, "child-result"), "utf8")).toBe(
      "loaded from release image",
    );
  });

  test("triggers native restore instead of creating a second First Mate", async () => {
    const cwd = defaultFirstMateCwd;
    const { env, state } = await createHarness([]);
    const persistedSession = join(state, "current-session.jsonl");
    await writeFile(
      persistedSession,
      `${JSON.stringify({ cwd, id: "session-current", type: "session", version: 3 })}\n`,
      "utf8",
    );
    await writeFile(join(state, "agents.json"), JSON.stringify([
      {
        agent_session: { kind: "path", value: persistedSession },
        cwd,
        live: true,
        name: "firstmate",
        pane_id: "w1:p1",
      },
    ]));
    const child = Bun.spawn([process.execPath, runMate], {
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
      6_000,
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const calls = await readCalls(state);
    expect(calls.filter((call) => call[0] === "agent" && call[1] === "start")).toEqual([]);
    expect(calls.filter((call) => call.slice(0, 3).join(" ") === "terminal session observe")).toEqual([
      expectedObserve,
    ]);
  });

  test("moves a persisted Pi session onto the configured checkout", async () => {
    const paneId = "w1:p1";
    const { env, state } = await createHarness([]);
    const persistedSession = join(state, "session.jsonl");
    await writeFile(
      persistedSession,
      [
        JSON.stringify({
          cwd: "/opt/agentos/packages/default/resources/roles/firstmate",
          id: "session-1",
          type: "session",
          version: 3,
        }),
        JSON.stringify({ message: "preserve me", type: "message" }),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(state, "agents.json"), JSON.stringify([
      {
        agent_session: { kind: "path", value: persistedSession },
        cwd: env.AGENTOS_AGENT_CWD,
        name: "firstmate",
        pane_id: paneId,
      },
    ]));
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedStart = [
      "agent",
      "start",
      "firstmate",
      "--cwd",
      env.AGENTOS_AGENT_CWD!,
      "--no-focus",
      "--session",
      "agentos-firstmate-test",
      "--",
      "pi",
      "--no-context-files",
      "--session",
      persistedSession,
    ];

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call.length === expectedStart.length &&
        call.every((argument, index) => argument === expectedStart[index]),
      ),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const calls = await readCalls(state);
    expect(calls.filter((call) => call[0] === "pane" && call[1] === "close")).toEqual([
      ["pane", "close", paneId, "--session", "agentos-firstmate-test"],
    ]);
    expect(calls.filter((call) => call[0] === "agent" && call[1] === "start")).toEqual([
      expectedStart,
    ]);
    const sessionLines = (await readFile(persistedSession, "utf8")).trim().split("\n");
    expect(JSON.parse(sessionLines[0]!)).toEqual({
      cwd: env.AGENTOS_AGENT_CWD,
      id: "session-1",
      type: "session",
      version: 3,
    });
    expect(JSON.parse(sessionLines[1]!)).toEqual({ message: "preserve me", type: "message" });
  });

  test("restarts a persisted Pi session when Herdr restored only stale pane metadata", async () => {
    const paneId = "w1:p1";
    const { env, state } = await createHarness([]);
    const persistedSession = join(state, "ghost-session.jsonl");
    await writeFile(
      persistedSession,
      `${JSON.stringify({ cwd: env.AGENTOS_AGENT_CWD, id: "session-ghost", type: "session", version: 3 })}\n`,
      "utf8",
    );
    await writeFile(join(state, "agents.json"), JSON.stringify([
      {
        agent_session: { kind: "path", value: persistedSession },
        cwd: env.AGENTOS_AGENT_CWD,
        live: false,
        name: "firstmate",
        pane_id: paneId,
      },
    ]));
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call[0] === "agent" &&
        call[1] === "start" &&
        call.includes(persistedSession),
      ),
      6_000,
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const calls = await readCalls(state);
    expect(calls).toContainEqual([
      "pane",
      "process-info",
      "--pane",
      paneId,
      "--session",
      "agentos-firstmate-test",
    ]);
    expect(calls).toContainEqual([
      "pane",
      "close",
      paneId,
      "--session",
      "agentos-firstmate-test",
    ]);
  });

  test("fails closed when persisted identity is ambiguous", async () => {
    const { env, state } = await createHarness([
      { name: "firstmate" },
      { name: "firstmate" },
    ]);
    const child = Bun.spawn([process.execPath, runMate], {
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

  test("fails closed without an explicit distribution root", async () => {
    const { env, state } = await createHarness([]);
    const invalidEnvironment: Record<string, string | undefined> = {
      ...env,
      AGENTOS_DISTRIBUTION_ROOT: undefined,
    };

    const child = Bun.spawn([process.execPath, runMate], {
      env: invalidEnvironment,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("AGENTOS_DISTRIBUTION_ROOT");
    expect(await readCalls(state)).toEqual([]);
  });

  test("fails closed when the Pi working directory is outside the selected role", async () => {
    const { env, state } = await createHarness([], {
      AGENTOS_AGENT_CWD: join(repository, "somewhere-else"),
    });

    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `AGENTOS_AGENT_CWD must equal ${defaultFirstMateCwd}`,
    );
    expect(await readCalls(state)).toEqual([]);
  });

  test("separates server liveness from required-agent readiness", async () => {
    const { env, state } = await createHarness([]);

    expect((await runHealth(env, "live")).exitCode).toBe(0);
    expect((await runHealth(env, "ready")).exitCode).toBe(1);

    await writeFile(
      join(state, "agents.json"),
      JSON.stringify([{ live: false, name: "firstmate", pane_id: "w1:p1" }]),
      "utf8",
    );
    expect((await runHealth(env, "ready")).exitCode).toBe(1);

    await writeFile(
      join(state, "agents.json"),
      JSON.stringify([{ live: true, name: "firstmate", pane_id: "w1:p1" }]),
      "utf8",
    );
    expect((await runHealth(env, "ready")).exitCode).toBe(0);
  });

  test("runs and checks the configured Second Mate identity", async () => {
    const secondMateCwd = join(
      defaultDistributionRoot,
      "resources",
      "roles",
      "secondmate",
    );
    const { env, state } = await createHarness([], {
      AGENTOS_AGENT_CWD: secondMateCwd,
      AGENTOS_AGENT_NAME: "delivery-second",
      AGENTOS_AGENT_ROLE: "second_mate",
      HERDR_SESSION: "agentos-delivery-second",
    });
    const child = Bun.spawn([process.execPath, runMate], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const expectedStart = [
      "agent",
      "start",
      "delivery-second",
      "--cwd",
      secondMateCwd,
      "--no-focus",
      "--session",
      "agentos-delivery-second",
      "--",
      "pi",
      "--no-context-files",
    ];

    await waitFor(async () =>
      (await readCalls(state)).some((call) =>
        call.length === expectedStart.length &&
        call.every((argument, index) => argument === expectedStart[index]),
      ),
    );
    expect((await runHealth(env, "ready")).exitCode).toBe(0);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });
});
