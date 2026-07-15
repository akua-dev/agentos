import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = new URL("../../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const runtime = new URL("..", import.meta.url).pathname;
const prepareHome = join(runtime, "runtime", "prepare-home.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function makeExecutable(path: string, contents: string) {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

async function run(script: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("First Mate home preparation", () => {
  test("reconciles released tools while preserving the agent-owned home", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-firstmate-home-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const fakeBin = join(sandbox, "bin");
    const logDirectory = join(sandbox, "logs");
    const customFragment = join(home, ".config", "mise", "conf.d", "custom.toml");
    const customTool = join(home, ".local", "share", "mise", "installs", "custom", "marker");
    const herdrConfig = join(home, ".config", "herdr", "config.toml");
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
      mkdir(dirname(customFragment), { recursive: true }),
      mkdir(dirname(customTool), { recursive: true }),
      mkdir(join(home, ".pi", "agent"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(customFragment, '[tools]\npython = "3.13"\n', "utf8"),
      writeFile(customTool, "agent-owned\n", "utf8"),
      writeFile(
        join(home, ".pi", "agent", "trust.json"),
        `${JSON.stringify({ "/workspace": false }, null, 2)}\n`,
        "utf8",
      ),
      makeExecutable(
        join(fakeBin, "mise"),
        `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
await appendFile(
  join(process.env.FAKE_LOG_DIRECTORY!, "mise.log"),
  process.argv.slice(2).join(" ") + "\\n",
);
`,
      ),
      makeExecutable(
        join(fakeBin, "herdr"),
        `#!/usr/bin/env bun
import { appendFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(
  join(process.env.FAKE_LOG_DIRECTORY!, "herdr.log"),
  args.join(" ") + "\\n",
);
if (args.join(" ") === "integration install pi") {
  const extensions = join(process.env.HOME!, ".pi", "agent", "extensions");
  await stat(extensions);
  await writeFile(join(extensions, "herdr-agent-state.ts"), "installed\\n");
}
`,
      ),
    ]);

    const environment = {
      AGENTOS_RELEASE_ROOT: repository,
      FAKE_LOG_DIRECTORY: logDirectory,
      HERDR_CONFIG_PATH: herdrConfig,
      HOME: home,
      MISE_SYSTEM_CONFIG_FILE: join(repository, "mise.toml"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };

    const cold = await run(prepareHome, environment);

    expect(cold).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(
      await readFile(join(home, ".config", "mise", "config.toml"), "utf8"),
    ).toBe(await readFile(join(repository, "agents", "mise.toml"), "utf8"));
    expect(
      await readFile(join(home, ".config", "mise", "mise.lock"), "utf8"),
    ).toBe(await readFile(join(repository, "agents", "mise.lock"), "utf8"));
    expect(await readFile(customFragment, "utf8")).toBe(
      '[tools]\npython = "3.13"\n',
    );
    expect(await readFile(customTool, "utf8")).toBe("agent-owned\n");
    expect(
      JSON.parse(await readFile(join(home, ".pi", "agent", "trust.json"), "utf8")),
    ).toEqual({
      "/workspace": false,
      [repository]: true,
    });
    expect(Bun.TOML.parse(await readFile(herdrConfig, "utf8"))).toEqual({
      onboarding: false,
      version_check: false,
      manifest_check: false,
      session: { resume_agents_on_restore: true },
      experimental: { pane_history: false },
    });
    expect(
      await readFile(
        join(home, ".pi", "agent", "extensions", "herdr-agent-state.ts"),
        "utf8",
      ),
    ).toBe("installed\n");
    expect((await readFile(join(logDirectory, "mise.log"), "utf8")).trim().split("\n")).toEqual([
      `trust ${join(repository, "mise.toml")}`,
      `trust ${join(home, ".config", "mise", "config.toml")}`,
    ]);
    expect((await readFile(join(logDirectory, "herdr.log"), "utf8")).trim().split("\n")).toEqual([
      "integration install pi",
    ]);

    const customHerdrConfig = '[theme]\nname = "agent-owned"\n';
    await writeFile(herdrConfig, customHerdrConfig, "utf8");
    const warm = await run(prepareHome, environment);

    expect(warm).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(await readFile(herdrConfig, "utf8")).toBe(customHerdrConfig);
    expect(await readFile(customFragment, "utf8")).toBe(
      '[tools]\npython = "3.13"\n',
    );
    expect(await readFile(customTool, "utf8")).toBe("agent-owned\n");
  });
});
