import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("@akua-dev/agentos public package", () => {
  test("uses the one public AgentOS package name", async () => {
    const manifest = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();

    expect(manifest.name).toBe("@akua-dev/agentos");
  });

  test("typechecks an external extension using documented exports only", async () => {
    const fixture = resolve(import.meta.dir, "fixtures", "external-extension", "index.ts");
    const child = Bun.spawn(
      [
        resolve(import.meta.dir, "../../../node_modules/.bin/tsc"),
        "--ignoreConfig",
        "--allowImportingTsExtensions",
        "--module",
        "Preserve",
        "--moduleResolution",
        "bundler",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ESNext",
        fixture,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
  });
});
