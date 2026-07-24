import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export async function assertOpenedFileStillAtPath(
  path: string,
  rootRealPath: string,
  opened: BigIntStats,
  description: string,
) {
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    metadataChanged(opened, current)
  ) {
    throw new Error(`${description} changed path identity while reading`);
  }

  const currentRealPath = await realpath(path);
  const fromRoot = relative(rootRealPath, currentRealPath);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${description} resolves outside its selected root`);
  }
}

export function metadataChanged(before: BigIntStats, after: BigIntStats) {
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
