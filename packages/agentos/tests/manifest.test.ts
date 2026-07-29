import { describe, expect, test } from "bun:test";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");

describe("@akua-dev/agentos Pi manifest", () => {
  test("is the only public package workspace", async () => {
    const directories = (await readdir(new URL("../../", import.meta.url), {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(directories).toEqual(["agentos"]);
  });

  test("publishes one root API with one extension entrypoint and one Skill root", async () => {
    const manifest = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    expect(manifest.name).toBe("@akua-dev/agentos");
    expect(manifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    expect(manifest.dependencies).not.toHaveProperty(manifest.name);
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./extensions/agentos.ts"],
      skills: ["./skills"],
    });
    expect(manifest.pi.prompts).toBeUndefined();
  });

  test("does not retain retired composition-era Skill paths", async () => {
    await Promise.all(
      [
        resolve(repository, "agents"),
        resolve(repository, "packages", "agentos", "skills", "agentos-fleet-upgrade"),
      ].map((path) => expect(access(path)).rejects.toThrow()),
    );
  });
});
