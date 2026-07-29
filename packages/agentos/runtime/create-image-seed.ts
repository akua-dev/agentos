#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

type ImageSeedOptions = {
  origin: string;
  output: string;
  source: string;
  upstream?: string;
};

try {
  await createImageSeed(parseArguments(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function createImageSeed({
  origin,
  output,
  source,
  upstream,
}: ImageSeedOptions) {
  assertCredentialFreeRemote("origin", origin);
  if (upstream) assertCredentialFreeRemote("upstream", upstream);
  if (await exists(output)) throw new Error(`${output} already exists`);

  const status = await $`git -C ${source} status --porcelain --untracked-files=all`.text();
  if (status.trim()) {
    throw new Error("AgentOS image source must be clean and committed");
  }

  await mkdir(dirname(output), { recursive: true });
  await $`git init --quiet ${output}`;
  await $`git -C ${output} fetch --quiet --depth 1 --no-tags ${pathToFileURL(source).href} HEAD`;
  await $`git -C ${output} checkout --quiet --detach FETCH_HEAD`;
  await $`git -C ${output} remote add origin ${origin}`;
  if (upstream && upstream !== origin) {
    await $`git -C ${output} remote add upstream ${upstream}`;
  }
}

function assertCredentialFreeRemote(name: string, value: string) {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must use a credential-free HTTPS or SSH URL`);
  }
  const credentialFreeHttps =
    url.protocol === "https:" && !url.username && !url.password;
  const credentialFreeSsh = url.protocol === "ssh:" && !url.password;
  if (!credentialFreeHttps && !credentialFreeSsh) {
    throw new Error(`${name} must use a credential-free HTTPS or SSH URL`);
  }
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

function parseArguments(arguments_: string[]): ImageSeedOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const origin = values.get("origin");
  const output = values.get("output");
  const source = values.get("source");
  const upstream = values.get("upstream");
  const expectedSize = upstream ? 4 : 3;
  if (!origin || !output || !source || values.size !== expectedSize) usage();
  return { origin, output, source, upstream };
}

function usage(): never {
  throw new Error(
    "Usage: create-image-seed.ts --source <checkout> --output <directory> --origin <url> [--upstream <url>]",
  );
}
