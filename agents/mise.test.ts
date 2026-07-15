import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise real Mise resolution; never replace this with config-text assertions.
const root = new URL("..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function runMise(cwd: string, systemConfigDirectory: string) {
  const home = join(systemConfigDirectory, "home");
  await mkdir(home, { recursive: true });

  const child = Bun.spawn(["mise", "ls", "--current", "--json"], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      MISE_CACHE_DIR: join(systemConfigDirectory, "cache"),
      MISE_CEILING_PATHS: cwd,
      MISE_CONFIG_DIR: join(home, ".config", "mise"),
      MISE_DATA_DIR: join(systemConfigDirectory, "data"),
      MISE_SYSTEM_CONFIG_DIR: systemConfigDirectory,
      MISE_TRUSTED_CONFIG_PATHS: cwd,
    },
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

function requestedTools(stdout: string) {
  const tools = JSON.parse(stdout) as Record<
    string,
    Array<{ requested_version: string }>
  >;

  return Object.fromEntries(
    Object.entries(tools).map(([tool, versions]) => [
      tool,
      versions[0]?.requested_version,
    ]),
  );
}

async function installFleetBaseline(systemConfigDirectory: string) {
  const agentConfigDirectory = join(
    systemConfigDirectory,
    "home",
    ".config",
    "mise",
  );
  await mkdir(systemConfigDirectory, { recursive: true });
  await mkdir(agentConfigDirectory, { recursive: true });

  await Promise.all([
    copyFile(
      join(root, "mise.toml"),
      join(systemConfigDirectory, "config.toml"),
    ),
    copyFile(
      join(root, "mise.lock"),
      join(systemConfigDirectory, "mise.lock"),
    ),
    copyFile(
      join(root, "agents", "mise.toml"),
      join(agentConfigDirectory, "config.toml"),
    ),
    copyFile(
      join(root, "agents", "mise.lock"),
      join(agentConfigDirectory, "mise.lock"),
    ),
  ]);
}

const fleetTools = {
  fd: "10.4.2",
  gh: "2.96.0",
  "github:kunchenguid/no-mistakes": "1.37.0",
  "github:ogulcancelik/herdr": "0.7.3",
  "github:oven-sh/bun": "canary",
  jq: "1.8.2",
  kubectl: "1.36.2",
  node: "24",
  "npm:@earendil-works/pi-coding-agent": "0.80.7",
  "npm:chrome-devtools-axi": "0.1.26",
  "npm:gh-axi": "0.1.27",
  "npm:lavish-axi": "0.1.42",
  "npm:quota-axi": "0.1.5",
  ripgrep: "15.1.0",
};

describe("AgentOS mise baseline", () => {
  test("provides baseline tools outside the AgentOS repository", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "agentos-mise-baseline-"),
    );
    temporaryDirectories.push(temporaryDirectory);

    const systemConfigDirectory = join(temporaryDirectory, "etc-mise");
    const foreignWorktree = join(temporaryDirectory, "foreign-worktree");
    await mkdir(foreignWorktree, { recursive: true });
    await installFleetBaseline(systemConfigDirectory);

    const result = await runMise(foreignWorktree, systemConfigDirectory);

    expect(result.exitCode).toBe(0);
    expect(requestedTools(result.stdout)).toEqual(fleetTools);
  });

  test("lets a foreign worktree override one tool and retain the baseline", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "agentos-mise-override-"),
    );
    temporaryDirectories.push(temporaryDirectory);

    const systemConfigDirectory = join(temporaryDirectory, "etc-mise");
    const foreignWorktree = join(temporaryDirectory, "foreign-worktree");
    await mkdir(foreignWorktree, { recursive: true });
    await installFleetBaseline(systemConfigDirectory);
    await writeFile(
      join(foreignWorktree, "mise.toml"),
      '[tools]\nnode = "22"\n',
      "utf8",
    );

    const result = await runMise(foreignWorktree, systemConfigDirectory);

    expect(result.exitCode).toBe(0);
    expect(requestedTools(result.stdout)).toEqual({
      ...fleetTools,
      node: "22",
    });
    expect(result.stderr).toBe("");
  });
});
