import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Mate server-compaction discovery", () => {
  for (const role of ["firstmate", "secondmate"] as const) {
    test(`${role} loads the AgentOS-owned extension without package installation`, async () => {
      const agentDirectory = await mkdtemp(join(tmpdir(), `agentos-pi-${role}-`));
      temporaryDirectories.push(agentDirectory);

      const loaded = await discoverAndLoadExtensions(
        [],
        resolve(import.meta.dir, `../../../${role}`),
        agentDirectory,
      );

      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions.map((extension) => basename(extension.path))).toContain(
        "agentos-openai-server-compaction.ts",
      );
    });
  }
});
