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
const fleetConfigDirectory =
  process.env.MISE_CONFIG_DIR ?? join(home, ".config", "mise");
const herdrConfig =
  process.env.HERDR_CONFIG_PATH ??
  join(home, ".config", "herdr", "config.toml");
const piAgentDirectory =
  process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");

await Promise.all(
  [
    join(fleetConfigDirectory, "conf.d"),
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise"),
    join(home, ".local", "state", "agentos"),
    join(home, "projects"),
    dirname(herdrConfig),
    join(piAgentDirectory, "extensions"),
  ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
);

await Promise.all([
  copyPrivateFile(
    join(releaseRoot, "agents", "mise.toml"),
    join(fleetConfigDirectory, "config.toml"),
  ),
  copyPrivateFile(
    join(releaseRoot, "agents", "mise.lock"),
    join(fleetConfigDirectory, "mise.lock"),
  ),
]);

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
await $`mise trust ${join(fleetConfigDirectory, "config.toml")}`;

const trustFile = join(piAgentDirectory, "trust.json");
const nextTrustFile = `${trustFile}.agentos-next`;
const trust = (await exists(trustFile))
  ? (JSON.parse(await readFile(trustFile, "utf8")) as Record<string, boolean>)
  : {};
trust[releaseRoot] = true;
await writeFile(nextTrustFile, `${JSON.stringify(trust, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(nextTrustFile, 0o600);
await rename(nextTrustFile, trustFile);

await $`herdr integration install pi`;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point at the mounted First Mate home`);
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
