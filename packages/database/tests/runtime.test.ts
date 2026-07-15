import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMigrationWorkspace } from "../runtime/prepare.ts";

const temporaryDirectories: string[] = [];
const releaseRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("prepares a reusable migration workspace outside the release image", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentos-database-runtime-"));
  temporaryDirectories.push(dataDirectory);

  const first = await prepareMigrationWorkspace({ dataDirectory, releaseRoot });
  const second = await prepareMigrationWorkspace({ dataDirectory, releaseRoot });

  expect(second).toBe(first);
  expect(await readFile(join(first, "AGENTS.md"), "utf8")).toBe(
    await readFile(join(releaseRoot, "packages", "database", "AGENTS.md"), "utf8"),
  );
  const result = await $`bun run migration:check`.cwd(first).quiet();
  expect(result.exitCode).toBe(0);
});
