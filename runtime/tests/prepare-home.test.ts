import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const mateRuntime = join(repository, "runtime");
const prepareHome = join(mateRuntime, "prepare-home.ts");
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

describe("Mate home preparation", () => {
  test("seeds a persistent checkout while preserving the agent-owned home", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-firstmate-home-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const fakeBin = join(sandbox, "bin");
    const logDirectory = join(sandbox, "logs");
    const customFragment = join(home, ".config", "mise", "conf.d", "custom.toml");
    const customTool = join(home, ".local", "share", "mise", "installs", "custom", "marker");
    const herdrConfig = join(home, ".config", "herdr", "config.toml");
    const piSettings = join(home, ".pi", "agent", "settings.json");
    const pgpassSource = join(sandbox, "secrets", "pgpass");
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
      mkdir(dirname(customFragment), { recursive: true }),
      mkdir(dirname(customTool), { recursive: true }),
      mkdir(join(home, ".pi", "agent"), { recursive: true }),
      mkdir(dirname(pgpassSource), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(customFragment, '[tools]\npython = "3.13"\n', "utf8"),
      writeFile(customTool, "agent-owned\n", "utf8"),
      writeFile(
        piSettings,
        `${JSON.stringify({ theme: "agent-owned" }, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(home, ".pi", "agent", "trust.json"),
        `${JSON.stringify({ "/workspace": false }, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        pgpassSource,
        "postgres.example.internal:5432:agentos:runtime_second:secret\n",
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
      AGENTOS_AGENT_ROLE: "first_mate",
      FAKE_LOG_DIRECTORY: logDirectory,
      HERDR_CONFIG_PATH: herdrConfig,
      HOME: home,
      AGENTOS_PGPASS_SOURCE: pgpassSource,
      MISE_SYSTEM_CONFIG_FILE: join(repository, "mise.toml"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };

    const cold = await run(prepareHome, environment);

    expect(cold).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    await expect(
      stat(join(home, ".config", "mise", "config.toml")),
    ).rejects.toThrow();
    await expect(
      stat(join(home, ".agents", "skills", "agentos-delegation")),
    ).rejects.toThrow();
    const checkout = join(home, "projects", "agentos");
    expect((await $`git -C ${checkout} rev-parse HEAD`.text()).trim()).toBe(
      (await $`git -C ${repository} rev-parse HEAD`.text()).trim(),
    );
    expect(
      (await $`git -C ${checkout} remote get-url origin`.text()).trim(),
    ).toBe((await $`git -C ${repository} remote get-url origin`.text()).trim());
    expect(await readFile(customFragment, "utf8")).toBe(
      '[tools]\npython = "3.13"\n',
    );
    expect(await readFile(customTool, "utf8")).toBe("agent-owned\n");
    expect(
      JSON.parse(await readFile(join(home, ".pi", "agent", "trust.json"), "utf8")),
    ).toEqual({
      "/workspace": false,
      [repository]: true,
      [checkout]: true,
    });
    expect(JSON.parse(await readFile(piSettings, "utf8"))).toEqual({
      theme: "agent-owned",
    });
    expect(await readFile(join(home, ".pgpass"), "utf8")).toBe(
      "postgres.example.internal:5432:agentos:runtime_second:secret\n",
    );
    expect((await stat(join(home, ".pgpass"))).mode & 0o777).toBe(0o600);
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
    await expect(
      stat(join(home, ".pi", "agent", "extensions", "agentos-pi-defaults.ts")),
    ).rejects.toThrow();
    expect((await readFile(join(logDirectory, "mise.log"), "utf8")).trim().split("\n")).toEqual([
      `trust ${join(repository, "mise.toml")}`,
      `trust ${join(checkout, "mise.toml")}`,
      `trust ${join(checkout, "agents", "firstmate", "mise.toml")}`,
    ]);
    expect((await readFile(join(logDirectory, "herdr.log"), "utf8")).trim().split("\n")).toEqual([
      "integration install pi",
    ]);

    const customHerdrConfig = '[theme]\nname = "agent-owned"\n';
    await writeFile(herdrConfig, customHerdrConfig, "utf8");
    await writeFile(
      piSettings,
      `${JSON.stringify(
        {
          defaultModel: "gpt-5.4",
          defaultProvider: "openai-codex",
          defaultThinkingLevel: "low",
          theme: "agent-owned",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const warm = await run(prepareHome, environment);

    expect(warm).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(await readFile(herdrConfig, "utf8")).toBe(customHerdrConfig);
    expect(await readFile(customFragment, "utf8")).toBe(
      '[tools]\npython = "3.13"\n',
    );
    expect(await readFile(customTool, "utf8")).toBe("agent-owned\n");
    expect(JSON.parse(await readFile(piSettings, "utf8"))).toEqual({
      defaultModel: "gpt-5.4",
      defaultProvider: "openai-codex",
      defaultThinkingLevel: "low",
      theme: "agent-owned",
    });
    const persistentMarker = join(checkout, ".fleet-marker");
    await writeFile(persistentMarker, "unfinished work\n", "utf8");

    const restarted = await run(prepareHome, environment);

    expect(restarted).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(await readFile(persistentMarker, "utf8")).toBe("unfinished work\n");
  });
});
