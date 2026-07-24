#!/usr/bin/env bun

import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { inspectMaterialDirectory } from "../../runtime/composition/digest.ts";
import {
  assertOpenedFileStillAtPath,
  metadataChanged,
} from "../../runtime/composition/filesystem.ts";
import {
  digestCompositionManifest,
  parseCompositionManifest,
  type CompositionMaterial,
  type CompositionManifest,
} from "../../runtime/composition/manifest.ts";

const maximumManifestBytes = 8 * 1024 * 1024;
const maximumSkillFrontmatterBytes = 64 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const help = `Usage: composition-verify <bundle-directory> [--manifest-digest <sha256>]

Validate one resolved composition manifest and every selected material in its
Assignment-scoped bundle, including native-loadable Skill metadata. Prints the
canonical manifest digest and material count as JSON.
It does not fetch, copy, install, load or activate anything.
`;

export async function verifyCompositionBundle(
  directory: string,
  expectedManifestDigest?: string,
) {
  const bundle = resolve(directory);
  const root = await lstat(bundle, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("composition bundle must be a non-symlink directory");
  }
  const bundleRealPath = await realpath(bundle);

  const manifest = await readManifest(
    join(bundle, "manifest.json"),
    bundleRealPath,
  );
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
  await verifySelectedBundleEntries(
    bundle,
    materialsDirectory,
    selected,
    manifest.materials.length > 0,
  );

  for (const material of manifest.materials) {
    const materialDirectory = join(materialsDirectory, material.id);
    const inspection = await inspectMaterialDirectory(
      materialDirectory,
      {
        path: material.entrypoint,
        maximumPrefixBytes:
          material.kind === "skill" ? maximumSkillFrontmatterBytes : 0,
        requireUtf8: material.kind === "skill",
      },
    );
    if (inspection.digest !== material.digest) {
      throw new Error(
        `material digest mismatch for ${material.id}: expected ${material.digest}, observed ${inspection.digest}`,
      );
    }
    if (material.kind === "skill") {
      verifySkillEntrypoint(
        inspection.observedPrefix!,
        material,
      );
    }
  }

  await verifySelectedBundleEntries(
    bundle,
    materialsDirectory,
    selected,
    manifest.materials.length > 0,
  );
  const rootAfter = await lstat(bundle, { bigint: true });
  if (
    rootAfter.isSymbolicLink() ||
    !rootAfter.isDirectory() ||
    metadataChanged(root, rootAfter) ||
    (await realpath(bundle)) !== bundleRealPath
  ) {
    throw new Error("composition bundle changed while verifying");
  }

  return {
    manifest_digest: manifestDigest,
    materials: manifest.materials.length,
  };
}

async function verifySelectedBundleEntries(
  bundle: string,
  materialsDirectory: string,
  selected: Set<string>,
  hasMaterials: boolean,
) {
  const allowedRootEntries = new Set(["manifest.json"]);
  if (hasMaterials) allowedRootEntries.add("materials");

  for (const entry of await readdir(bundle, { withFileTypes: true })) {
    if (!allowedRootEntries.has(entry.name)) {
      throw new Error(`composition bundle contains unselected entry: ${entry.name}`);
    }
  }

  if (!hasMaterials) return;
  const materialsMetadata = await lstat(materialsDirectory);
  if (materialsMetadata.isSymbolicLink() || !materialsMetadata.isDirectory()) {
    throw new Error(
      "composition materials directory must be a non-symlink directory",
    );
  }
  for (const entry of await readdir(materialsDirectory, {
    withFileTypes: true,
  })) {
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

function verifySkillEntrypoint(
  prefixBytes: Uint8Array,
  material: CompositionMaterial,
) {
  const prefix = new TextDecoder("utf-8").decode(prefixBytes);
  const normalized = prefix.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    throw new Error(
      `Skill entrypoint requires YAML frontmatter within ${maximumSkillFrontmatterBytes} bytes`,
    );
  }
  const frontmatter = match[1]!;
  const document = parseDocument(frontmatter, {
    schema: "core",
  });
  if (document.errors.length > 0) {
    throw new Error(
      `Skill ${material.id} has invalid YAML frontmatter: ${document.errors[0]!.message}`,
    );
  }

  const value = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value)) {
    throw new Error(`Skill ${material.id} frontmatter must be an object`);
  }

  const name = value.name;
  if (typeof name !== "string" || name !== material.id) {
    throw new Error(
      `Skill name ${typeof name === "string" ? name : "<missing>"} does not match material ID ${material.id}`,
    );
  }
  if (
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error(`Skill ${material.id} has an invalid Skill name`);
  }
  const description = value.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`Skill ${material.id} requires a non-empty description`);
  }
  if (description.length > 1024) {
    throw new Error(`Skill ${material.id} description exceeds 1024 characters`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readManifest(
  path: string,
  bundleRealPath: string,
): Promise<CompositionManifest> {
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
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

    const bytes = Buffer.allocUnsafe(maximumManifestBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const result = await file.read(
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        null,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximumManifestBytes) {
      throw new Error(
        `composition manifest exceeds ${maximumManifestBytes} bytes`,
      );
    }

    const after = await file.stat({ bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      metadataChanged(before, after)
    ) {
      throw new Error("composition manifest changed while reading");
    }
    await assertOpenedFileStillAtPath(
      path,
      bundleRealPath,
      after,
      "composition manifest",
    );

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      );
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
