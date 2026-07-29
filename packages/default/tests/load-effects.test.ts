import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("@akua-dev/agentos-default module load", () => {
  test("is inert before Pi invokes its exported factory", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentos-default-import-"));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const loaded = await import(`../extensions/agentos.ts?test=${Date.now()}`);
      expect(loaded.default).toBeFunction();
      expect(await readdir(home)).toEqual([]);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
