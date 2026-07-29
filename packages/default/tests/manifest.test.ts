import { describe, expect, test } from "bun:test";

describe("@agentos/default Pi manifest", () => {
  test("exposes exactly one extension entrypoint and one Skill root", async () => {
    const manifest = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    expect(manifest.name).toBe("@agentos/default");
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./extensions/agentos.ts"],
      skills: ["./skills"],
    });
    expect(manifest.pi.prompts).toBeUndefined();
  });
});
