import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  assertOpenedFileStillAtPath,
  metadataChanged,
} from "./filesystem.ts";

export async function digestMaterialDirectory(
  directory: string,
): Promise<string> {
  return (await inspectMaterialDirectory(directory)).digest;
}

export async function inspectMaterialDirectory(
  directory: string,
  observedFile?: {
    path: string;
    maximumPrefixBytes?: number;
    requireUtf8?: boolean;
  },
): Promise<{
  digest: string;
  observedPrefix?: Uint8Array;
}> {
  const root = await lstat(directory, { bigint: true });
  if (root.isSymbolicLink()) {
    throw new Error(`Composition material root is a symlink: ${directory}`);
  }
  if (!root.isDirectory()) {
    throw new Error(`Composition material root is not a directory: ${directory}`);
  }
  const rootRealPath = await realpath(directory);

  const hash = createHash("sha256");
  let observedPrefix: Uint8Array | undefined;

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
      const observesThisFile = observedFile?.path === relativePath;
      const maximumPrefixBytes = observedFile?.maximumPrefixBytes ?? 0;
      const prefixChunks: Uint8Array[] = [];
      let prefixBytes = 0;
      const decoder =
        observesThisFile && observedFile?.requireUtf8
          ? new TextDecoder("utf-8", { fatal: true })
          : undefined;
      hash.update("file\0");
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(before.mode & 0o111n ? "executable" : "regular");
      hash.update("\0");
      hash.update(String(before.size));
      hash.update("\0");

      let bytesRead = 0n;
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          bytesRead += BigInt(chunk.byteLength);
          hash.update(chunk);
          decoder?.decode(chunk, { stream: true });
          if (observesThisFile && prefixBytes < maximumPrefixBytes) {
            const retained = chunk.subarray(
              0,
              maximumPrefixBytes - prefixBytes,
            );
            prefixChunks.push(Uint8Array.from(retained));
            prefixBytes += retained.byteLength;
          }
        }
        decoder?.decode();
      } catch (error) {
        if (error instanceof TypeError && decoder) {
          throw new Error(
            `Composition material observed file is not valid UTF-8: ${path}`,
          );
        }
        throw error;
      }

      const after = await file.stat({ bigint: true });
      if (bytesRead !== before.size || metadataChanged(before, after)) {
        throw new Error(`Composition material changed while hashing: ${path}`);
      }
      await assertOpenedFileStillAtPath(
        path,
        rootRealPath,
        after,
        "Composition material",
      );
      if (observesThisFile) {
        observedPrefix = Buffer.concat(prefixChunks);
      }
      hash.update("\0");
    } finally {
      await file.close();
    }
  }

  const rootAfter = await lstat(directory, { bigint: true });
  if (
    rootAfter.isSymbolicLink() ||
    !rootAfter.isDirectory() ||
    metadataChanged(root, rootAfter) ||
    (await realpath(directory)) !== rootRealPath
  ) {
    throw new Error(
      `Composition material root changed while hashing: ${directory}`,
    );
  }

  if (observedFile !== undefined && observedPrefix === undefined) {
    throw new Error(
      `Composition material observed file is not a regular file: ${observedFile.path}`,
    );
  }

  return {
    digest: `sha256:${hash.digest("hex")}`,
    observedPrefix,
  };
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
