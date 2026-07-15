#!/usr/bin/env bun

import { $ } from "bun";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type PrepareOptions = {
  dataDirectory?: string;
  releaseRoot?: string;
};

const defaultReleaseRoot = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

export async function prepareMigrationWorkspace({
  dataDirectory = join(
    process.env.HOME ?? homedir(),
    ".local",
    "share",
    "agentos",
    "database",
  ),
  releaseRoot = process.env.AGENTOS_RELEASE_ROOT ?? defaultReleaseRoot,
}: PrepareOptions = {}): Promise<string> {
  const files = await releaseFiles(releaseRoot);
  const hash = new Bun.CryptoHasher("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update(await readFile(join(releaseRoot, relativePath)));
  }

  const releaseKey = hash.digest("hex");
  const targetRoot = join(dataDirectory, releaseKey);
  const targetPackage = join(targetRoot, "packages", "database");
  const readyFile = join(targetRoot, ".ready");
  if (await exists(readyFile)) return targetPackage;

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const stagingRoot = join(dataDirectory, `.${releaseKey}-${process.pid}`);
  await rm(stagingRoot, { force: true, recursive: true });

  try {
    for (const relativePath of files) {
      const destination = join(stagingRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(releaseRoot, relativePath), destination);
    }

    await $`bun install --frozen-lockfile --production --filter @agentos/database --no-progress`
      .cwd(stagingRoot)
      .quiet();
    await writeFile(join(stagingRoot, ".ready"), `${releaseKey}\n`, {
      mode: 0o600,
    });
    await rm(targetRoot, { force: true, recursive: true });
    await rename(stagingRoot, targetRoot);
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }

  return targetPackage;
}

async function releaseFiles(releaseRoot: string): Promise<string[]> {
  const files = new Set(["bun.lock", "bunfig.toml", "package.json"]);
  const rootPackage = JSON.parse(
    await readFile(join(releaseRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };

  for (const workspace of rootPackage.workspaces ?? []) {
    const manifests = new Bun.Glob(`${workspace}/package.json`);
    for await (const path of manifests.scan({ cwd: releaseRoot, onlyFiles: true })) {
      files.add(path);
    }
  }

  for (const path of [
    "packages/database/AGENTS.md",
    "packages/database/README.md",
    "packages/database/package.json",
    "packages/database/drizzle.config.ts",
    "packages/database/drizzle.tooling.ts",
    "packages/database/runtime/prepare.ts",
    "packages/database/sql.d.ts",
  ]) {
    files.add(path);
  }

  const databaseFiles = new Bun.Glob("packages/database/migrations/**/*");
  for await (const path of databaseFiles.scan({ cwd: releaseRoot, onlyFiles: true })) {
    files.add(path);
  }

  return [...files].sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  console.log(await prepareMigrationWorkspace());
}
