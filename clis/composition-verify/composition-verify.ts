#!/usr/bin/env bun

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestMaterialDirectory } from "../../runtime/composition/digest.ts";
import {
  digestCompositionManifest,
  parseCompositionManifest,
  type CompositionManifest,
} from "../../runtime/composition/manifest.ts";

const maximumManifestBytes = 8 * 1024 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const help = `Usage: composition-verify <bundle-directory> [--manifest-digest <sha256>]

Validate one resolved composition manifest and every selected material in its
Assignment-scoped bundle. Prints the canonical manifest digest and material
count as JSON. It does not fetch, copy, install, load or activate anything.
`;

export async function verifyCompositionBundle(
  directory: string,
  expectedManifestDigest?: string,
) {
  const bundle = resolve(directory);
  const root = await lstat(bundle);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("composition bundle must be a non-symlink directory");
  }

  const manifest = await readManifest(join(bundle, "manifest.json"));
  const manifestDigest = digestCompositionManifest(manifest);
  if (
    expectedManifestDigest !== undefined &&
    manifestDigest !== expectedManifestDigest
  ) {
    throw new Error(
      `manifest digest mismatch: expected ${expectedManifestDigest}, observed ${manifestDigest}`,
    );
  }

  const selected = new Set(manifest.materials.map((material) => material.id));
  const materialsDirectory = join(bundle, "materials");
  const allowedRootEntries = new Set(["manifest.json"]);
  if (manifest.materials.length > 0) allowedRootEntries.add("materials");

  for (const entry of await readdir(bundle, { withFileTypes: true })) {
    if (!allowedRootEntries.has(entry.name)) {
      throw new Error(`composition bundle contains unselected entry: ${entry.name}`);
    }
  }

  if (manifest.materials.length > 0) {
    const entries = await readdir(materialsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!selected.has(entry.name)) {
        throw new Error(`composition bundle contains unselected material: ${entry.name}`);
      }
      const path = join(materialsDirectory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          `composition material must be a non-symlink directory: ${entry.name}`,
        );
      }
    }
  }

  for (const material of manifest.materials) {
    const materialDirectory = join(materialsDirectory, material.id);
    const observedDigest = await digestMaterialDirectory(materialDirectory);
    if (observedDigest !== material.digest) {
      throw new Error(
        `material digest mismatch for ${material.id}: expected ${material.digest}, observed ${observedDigest}`,
      );
    }

    const entrypoint = await lstat(
      join(materialDirectory, material.entrypoint),
    );
    if (entrypoint.isSymbolicLink() || !entrypoint.isFile()) {
      throw new Error(
        `composition material entrypoint is not a regular file: ${material.id}`,
      );
    }
  }

  return {
    manifest_digest: manifestDigest,
    materials: manifest.materials.length,
  };
}

async function readManifest(path: string): Promise<CompositionManifest> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n) {
      throw new Error("composition manifest must be one regular file");
    }
    if (before.size > BigInt(maximumManifestBytes)) {
      throw new Error(
        `composition manifest exceeds ${maximumManifestBytes} bytes`,
      );
    }

    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      BigInt(bytes.byteLength) !== before.size ||
      changedDuringRead(before, after)
    ) {
      throw new Error("composition manifest changed while reading");
    }

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("composition manifest is not valid UTF-8");
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(contents);
    } catch {
      throw new Error("composition manifest is not valid JSON");
    }
    return parseCompositionManifest(candidate);
  } finally {
    await file.close();
  }
}

function changedDuringRead(before: BigIntStats, after: BigIntStats) {
  return (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  );
}

function parseArguments(arguments_: string[]) {
  if (arguments_.length === 0) throw new UsageError(help.trimEnd());
  const directory = arguments_[0]!;
  let manifestDigest: string | undefined;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--manifest-digest") {
      throw new UsageError(`unknown argument: ${argument}`);
    }
    manifestDigest = arguments_[index + 1];
    if (!manifestDigest || !digestPattern.test(manifestDigest)) {
      throw new UsageError("--manifest-digest requires one sha256 digest");
    }
    index += 1;
  }

  return { directory, manifestDigest };
}

class UsageError extends Error {}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(help);
  } else {
    try {
      const { directory, manifestDigest } = parseArguments(
        process.argv.slice(2),
      );
      const result = await verifyCompositionBundle(directory, manifestDigest);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = error instanceof UsageError ? 2 : 1;
    }
  }
}
