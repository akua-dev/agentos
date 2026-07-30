#!/usr/bin/env bun

import { $ } from "bun";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
} from "node:path";

import { createMateMemoryStore } from "@akua-dev/agentos";

import {
  isPersistentMateRole,
  resolvePersistentMateDistribution,
} from "./distribution.ts";
import { reconcileCodexOtelConfig } from "./codex-otel.ts";

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
const usesPi = isPersistentMateRole(agentRole);
const usesCodex = agentRole === "crewmate";
const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
const mateDistribution = usesPi
  ? resolvePersistentMateDistribution(process.env)
  : undefined;
const agentCheckout =
  process.env.AGENTOS_CHECKOUT ?? join(home, "projects", "agentos");
const piAgentDirectory =
  process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
const piExtensionDirectory = join(piAgentDirectory, "extensions");
const piSettings = join(piAgentDirectory, "settings.json");

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
    ...(usesCodex ? [codexHome] : []),
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
);

if (usesPi) {
  await ensureAgentosCheckout();
  await ensureSelectedDistribution();
}
if (usesPi) await createMateMemoryStore(home).ensureLayout();

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

if (usesPi) await reconcileSelectedPiDefaults();
if (usesCodex) {
  await reconcileCodexOtelConfig(join(codexHome, "config.toml"), process.env);
}

await $`mise trust ${systemConfig}`;
if (usesPi) {
  await $`mise trust ${join(agentCheckout, "mise.toml")}`;
  await $`mise trust ${join(mateDistribution!.roleDirectory, "mise.toml")}`;
}

if (usesPi) {
  const trustFile = join(piAgentDirectory, "trust.json");
  const nextTrustFile = `${trustFile}.agentos-next`;
  const trust = (await exists(trustFile))
    ? (JSON.parse(await readFile(trustFile, "utf8")) as Record<string, boolean>)
    : {};
  trust[releaseRoot] = true;
  trust[agentCheckout] = true;
  trust[mateDistribution!.distributionRoot] = true;
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

async function reconcileSelectedPiDefaults() {
  const selectedModel = selectedEnvironment("AGENTOS_MODEL");
  const selectedThinking = selectedEnvironment("AGENTOS_THINKING");
  if (!selectedModel && !selectedThinking) return;

  const settings = (await exists(piSettings))
    ? JSON.parse(await readFile(piSettings, "utf8"))
    : {};
  if (
    settings === null ||
    Array.isArray(settings) ||
    typeof settings !== "object"
  ) {
    throw new Error(`${piSettings} must contain a JSON object`);
  }

  const selectedDefaults: Record<string, string> = {};
  if (selectedModel) {
    const separator = selectedModel.indexOf("/");
    if (separator <= 0 || separator === selectedModel.length - 1) {
      throw new Error("AGENTOS_MODEL must use Pi's provider/model form");
    }
    selectedDefaults.defaultProvider = selectedModel.slice(0, separator);
    selectedDefaults.defaultModel = selectedModel.slice(separator + 1);
  }
  if (selectedThinking) {
    selectedDefaults.defaultThinkingLevel = selectedThinking;
  }

  const next = `${piSettings}.agentos-next`;
  await writeFile(
    next,
    `${JSON.stringify({ ...settings, ...selectedDefaults }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(next, 0o600);
  await rename(next, piSettings);
}

function selectedEnvironment(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new Error(`${name} must be non-empty when configured`);
  return value;
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

async function ensureSelectedDistribution() {
  const distribution = mateDistribution!;
  if (await exists(distribution.roleDirectory)) return;
  if (await exists(distribution.distributionRoot)) {
    throw new Error(
      `${distribution.distributionRoot} exists but does not contain ${distribution.roleDirectory}`,
    );
  }

  const distributionPath = relative(
    agentCheckout,
    distribution.distributionRoot,
  );
  if (
    !distributionPath ||
    isAbsolute(distributionPath) ||
    distributionPath === ".." ||
    distributionPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      `${distribution.distributionRoot} is not a selected distribution in ${agentCheckout}`,
    );
  }

  const releaseDistribution = join(releaseRoot, distributionPath);
  if (!(await exists(releaseDistribution))) {
    throw new Error(
      `Selected distribution ${distribution.distributionRoot} is missing from ${releaseRoot}`,
    );
  }

  const parent = dirname(distribution.distributionRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryParent = await mkdtemp(join(parent, ".agentos-distribution-"));
  const temporaryDistribution = join(
    temporaryParent,
    basename(distribution.distributionRoot),
  );
  try {
    await cp(releaseDistribution, temporaryDistribution, { recursive: true });
    if (await exists(distribution.distributionRoot)) {
      throw new Error(
        `${distribution.distributionRoot} appeared while preparing the selected distribution`,
      );
    }
    await rename(temporaryDistribution, distribution.distributionRoot);
  } finally {
    await rm(temporaryParent, { force: true, recursive: true });
  }
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
