import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function digestMaterialDirectory(
  directory: string,
): Promise<string> {
  const root = await lstat(directory);
  if (root.isSymbolicLink()) {
    throw new Error(`Composition material root is a symlink: ${directory}`);
  }
  if (!root.isDirectory()) {
    throw new Error(`Composition material root is not a directory: ${directory}`);
  }

  const hash = createHash("sha256");

  for await (const path of regularFiles(directory)) {
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) {
        throw new Error(
          `Composition material changed into a non-file while hashing: ${path}`,
        );
      }
      if (before.nlink > 1n) {
        throw new Error(
          `Composition material contains a hard-linked file: ${path}`,
        );
      }

      const relativePath = relative(directory, path).split(sep).join("/");
      hash.update("file\0");
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(before.mode & 0o111n ? "executable" : "regular");
      hash.update("\0");
      hash.update(String(before.size));
      hash.update("\0");

      let bytesRead = 0n;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytesRead += BigInt(chunk.byteLength);
        hash.update(chunk);
      }

      const after = await file.stat({ bigint: true });
      if (bytesRead !== before.size || changedDuringRead(before, after)) {
        throw new Error(`Composition material changed while hashing: ${path}`);
      }
      hash.update("\0");
    } finally {
      await file.close();
    }
  }

  return `sha256:${hash.digest("hex")}`;
}

async function* regularFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
  )) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Composition material contains a symlink: ${path}`);
    }
    if (metadata.isDirectory()) {
      yield* regularFiles(path);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Composition material contains a special file: ${path}`);
    }
    yield path;
  }
}

function changedDuringRead(
  before: BigIntStats,
  after: BigIntStats,
) {
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
