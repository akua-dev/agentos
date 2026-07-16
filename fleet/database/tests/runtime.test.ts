import { afterEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMigrationWorkspace } from "../runtime/prepare.ts";

const temporaryDirectories: string[] = [];
const releaseRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

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
    await readFile(join(releaseRoot, "database", "AGENTS.md"), "utf8"),
  );
  const result = await $`bun run migration:check`.cwd(first).quiet();
  expect(result.exitCode).toBe(0);
});

test("keeps database tooling rooted in the implementation directory", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentos-database-runtime-"));
  temporaryDirectories.push(dataDirectory);
  const previousReleaseRoot = process.env.AGENTOS_RELEASE_ROOT;
  process.env.AGENTOS_RELEASE_ROOT = join(releaseRoot, "missing-repository-root");

  try {
    const prepared = await prepareMigrationWorkspace({ dataDirectory });
    expect(await readFile(join(prepared, "package.json"), "utf8")).toBe(
      await readFile(join(releaseRoot, "database", "package.json"), "utf8"),
    );
  } finally {
    if (previousReleaseRoot === undefined) {
      delete process.env.AGENTOS_RELEASE_ROOT;
    } else {
      process.env.AGENTOS_RELEASE_ROOT = previousReleaseRoot;
    }
  }
});
