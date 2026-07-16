#!/usr/bin/env bun

import { $ } from "bun";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const home = requiredEnvironment("HOME");
const releaseRoot = withoutTrailingSlash(
  process.env.AGENTOS_RELEASE_ROOT ?? "/opt/agentos",
);
const systemConfig =
  process.env.MISE_SYSTEM_CONFIG_FILE ?? "/etc/mise/config.toml";
const agentConfigDirectory =
  process.env.MISE_CONFIG_DIR ?? join(home, ".config", "mise");
const herdrConfig =
  process.env.HERDR_CONFIG_PATH ??
  join(home, ".config", "herdr", "config.toml");
const agentRole = requiredEnvironment("AGENTOS_AGENT_ROLE");
const usesPi = agentRole === "first_mate" || agentRole === "second_mate";
const agentCheckout =
  process.env.AGENTOS_CHECKOUT ?? join(home, "projects", "agentos");
const piAgentDirectory =
  process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
const piExtensionDirectory = join(piAgentDirectory, "extensions");

await Promise.all(
  [
    join(agentConfigDirectory, "conf.d"),
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise"),
    join(home, ".local", "state", "agentos"),
    join(home, ".agents", "skills"),
    join(home, "projects"),
    dirname(herdrConfig),
    ...(usesPi ? [piExtensionDirectory] : []),
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
);

if (usesPi) await ensureAgentosCheckout();

const pgpassSource = process.env.AGENTOS_PGPASS_SOURCE;
if (pgpassSource) {
  await copyPrivateFileAtomic(pgpassSource, join(home, ".pgpass"));
}

if (!(await exists(herdrConfig))) {
  await writeFile(
    herdrConfig,
    [
      "onboarding = false",
      "version_check = false",
      "manifest_check = false",
      "",
      "[session]",
      "resume_agents_on_restore = true",
      "",
      "[experimental]",
      "pane_history = false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

await $`mise trust ${systemConfig}`;
if (usesPi) {
  await $`mise trust ${join(agentCheckout, "mise.toml")}`;
  await $`mise trust ${join(agentCheckout, "agents", roleDirectory(), "mise.toml")}`;
}

if (usesPi) {
  const trustFile = join(piAgentDirectory, "trust.json");
  const nextTrustFile = `${trustFile}.agentos-next`;
  const trust = (await exists(trustFile))
    ? (JSON.parse(await readFile(trustFile, "utf8")) as Record<string, boolean>)
    : {};
  trust[releaseRoot] = true;
  trust[agentCheckout] = true;
  await writeFile(nextTrustFile, `${JSON.stringify(trust, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(nextTrustFile, 0o600);
  await rename(nextTrustFile, trustFile);

  await $`herdr integration install pi`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point at the mounted Mate home`);
  return value;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyPrivateFile(source: string, destination: string) {
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

async function copyPrivateFileAtomic(source: string, destination: string) {
  const next = `${destination}.agentos-next`;
  await copyPrivateFile(source, next);
  await rename(next, destination);
}

async function ensureAgentosCheckout() {
  if (await exists(join(agentCheckout, ".git"))) return;
  if (await exists(agentCheckout)) {
    throw new Error(
      `${agentCheckout} exists but is not an AgentOS Git checkout`,
    );
  }
  if (!(await exists(join(releaseRoot, ".git")))) {
    throw new Error(`${releaseRoot} must contain the image's AgentOS Git seed`);
  }

  await $`git -c safe.directory=${releaseRoot} clone --no-hardlinks ${releaseRoot} ${agentCheckout}`.quiet();
  await copyReleaseRemotes();
}

async function copyReleaseRemotes() {
  const source = await $`git -c safe.directory=${releaseRoot} -C ${releaseRoot} remote`.text();
  const remotes = source.split("\n").map((value) => value.trim()).filter(Boolean);
  const localOrigin = await $`git -C ${agentCheckout} remote`.text();
  for (const remote of localOrigin.split("\n").map((value) => value.trim()).filter(Boolean)) {
    await $`git -C ${agentCheckout} remote remove ${remote}`.quiet();
  }
  for (const remote of remotes) {
    const output = await $`git -c safe.directory=${releaseRoot} -C ${releaseRoot} remote get-url --all ${remote}`.text();
    const urls = output.split("\n").map((value) => value.trim()).filter(Boolean);
    if (urls.length === 0) continue;
    await $`git -C ${agentCheckout} remote add ${remote} ${urls[0]}`.quiet();
    for (const url of urls.slice(1)) {
      await $`git -C ${agentCheckout} remote set-url --add ${remote} ${url}`.quiet();
    }
  }
}

function roleDirectory(): string {
  if (agentRole === "first_mate") return "firstmate";
  if (agentRole === "second_mate") return "secondmate";
  throw new Error(`Role ${agentRole} does not use a persistent AgentOS checkout`);
}
