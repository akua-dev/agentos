import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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

const repository = new URL("../../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const mateRuntime = join(repository, "packages", "agentos", "runtime");
const prepareHome = join(mateRuntime, "prepare-home.ts");
const temporaryDirectories: string[] = [];

setDefaultTimeout(120_000);

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

function withoutEnvironment(
  environment: Record<string, string>,
  names: ReadonlyArray<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.includes(name)),
  );
}

describe("Mate home preparation", () => {
  test("reconciles Codex native OTEL config for a Crewmate from standard workload variables", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-crewmate-home-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const fakeBin = join(sandbox, "bin");
    await mkdir(fakeBin, { recursive: true });
    await makeExecutable(join(fakeBin, "mise"), "#!/bin/sh\nexit 0\n");

    const result = await run(prepareHome, {
      AGENTOS_AGENT_ROLE: "crewmate",
      HOME: home,
      MISE_SYSTEM_CONFIG_FILE: join(repository, "mise.toml"),
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://agentos-otel-collector:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment.name=test,service.namespace=agentos",
      OTEL_SDK_DISABLED: "false",
      OTEL_TRACES_EXPORTER: "otlp",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const path = join(home, ".codex", "config.toml");
    const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as {
      otel: Record<string, unknown>;
    };
    expect(parsed.otel.log_user_prompt).toBe(false);
    expect(parsed.otel.environment).toBe("test");
    expect(parsed.otel.trace_exporter).toEqual({
      "otlp-http": {
        endpoint: "http://agentos-otel-collector:4318/v1/traces",
        protocol: "binary",
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("seeds a checkout and selected Pi defaults while preserving the agent-owned home", async () => {
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

    const checkout = join(home, "projects", "agentos");
    const distributionRoot = join(checkout, "packages", "agentos");
    const roleDirectory = join(
      distributionRoot,
      "resources",
      "roles",
      "firstmate",
    );
    const environment = {
      AGENTOS_RELEASE_ROOT: repository,
      AGENTOS_AGENT_CWD: roleDirectory,
      AGENTOS_AGENT_ROLE: "first_mate",
      AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
      AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
      AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
      AGENTOS_THINKING: "xhigh",
      AI_GATEWAY_TOKEN: "synthetic-fleet-token",
      AI_GATEWAY_URL: "http://ai-gateway.agentos.svc.cluster.local:8787/",
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
      [distributionRoot]: true,
    });
    expect(JSON.parse(await readFile(piSettings, "utf8"))).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultProvider: "openai-codex",
      defaultThinkingLevel: "xhigh",
      theme: "agent-owned",
    });
    const piModels = join(home, ".pi", "agent", "models.json");
    const providerMarker = join(
      home,
      ".local",
      "state",
      "agentos",
      "pi-provider.json",
    );
    const providerReadiness = join(
      home,
      ".local",
      "state",
      "agentos",
      "pi-provider-readiness.json",
    );
    expect(
      JSON.parse(await readFile(piModels, "utf8")).providers["openai-codex"],
    ).toEqual({
      apiKey:
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder",
      baseUrl: "http://ai-gateway.agentos.svc.cluster.local:8787",
      headers: { "X-AI-Gateway-Token": "$AI_GATEWAY_TOKEN" },
    });
    expect(JSON.parse(await readFile(providerMarker, "utf8"))).toMatchObject({
      _tag: "Active",
      version: 1,
    });
    expect(await readFile(piModels, "utf8")).not.toContain(
      "synthetic-fleet-token",
    );
    const gatewayReadiness = JSON.parse(
      await readFile(providerReadiness, "utf8"),
    );
    expect(gatewayReadiness).toMatchObject({
      files: {
        markerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        modelsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        settingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      mode: "ai_gateway",
      selectedModel: "openai-codex/gpt-5.6-sol",
      selectedThinking: "xhigh",
      version: 1,
    });
    expect(JSON.stringify(gatewayReadiness)).not.toContain(
      "synthetic-fleet-token",
    );
    expect((await stat(providerReadiness)).mode & 0o777).toBe(0o600);
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
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory index\n",
    );
    await expect(
      stat(join(home, ".pi", "agent", "extensions", "agentos-pi-defaults.ts")),
    ).rejects.toThrow();
    expect((await readFile(join(logDirectory, "mise.log"), "utf8")).trim().split("\n")).toEqual([
      `trust ${join(repository, "mise.toml")}`,
      `trust ${join(checkout, "mise.toml")}`,
      `trust ${join(roleDirectory, "mise.toml")}`,
    ]);
    expect((await readFile(join(logDirectory, "herdr.log"), "utf8")).trim().split("\n")).toEqual([
      "integration install pi",
    ]);

    const customHerdrConfig = '[theme]\nname = "agent-owned"\n';
    await writeFile(
      join(home, "memory", "MEMORY.md"),
      "# Memory index\n- Preserve this\n",
      "utf8",
    );
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
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory index\n- Preserve this\n",
    );
    expect(await readFile(customFragment, "utf8")).toBe(
      '[tools]\npython = "3.13"\n',
    );
    expect(await readFile(customTool, "utf8")).toBe("agent-owned\n");
    expect(JSON.parse(await readFile(piSettings, "utf8"))).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultProvider: "openai-codex",
      defaultThinkingLevel: "xhigh",
      theme: "agent-owned",
    });
    const persistentMarker = join(checkout, ".fleet-marker");
    await writeFile(persistentMarker, "unfinished work\n", "utf8");

    const restarted = await run(prepareHome, environment);

    expect(restarted).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(await readFile(persistentMarker, "utf8")).toBe("unfinished work\n");

    const directEnvironment = {
      ...withoutEnvironment(environment, [
        "AI_GATEWAY_TOKEN",
        "AI_GATEWAY_URL",
      ]),
      AGENTOS_PI_PROVIDER_MODE: "direct",
    };
    const direct = await run(prepareHome, directEnvironment);
    expect(direct).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(
      JSON.parse(await readFile(piModels, "utf8")).providers["openai-codex"],
    ).toBeUndefined();
    expect(await Bun.file(providerMarker).exists()).toBe(false);
    expect(JSON.parse(await readFile(providerReadiness, "utf8"))).toMatchObject({
      files: { markerSha256: null },
      mode: "direct",
      selectedModel: "openai-codex/gpt-5.6-sol",
      selectedThinking: "xhigh",
      version: 1,
    });

    const unpatched = await run(
      prepareHome,
      withoutEnvironment(environment, [
        "AGENTOS_PI_PROVIDER_MODE",
        "AI_GATEWAY_TOKEN",
        "AI_GATEWAY_URL",
      ]),
    );
    expect(unpatched).toEqual({ exitCode: 0, stderr: "", stdout: "" });
  });

  test("materializes a selected distribution into an existing retained checkout", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-retained-distribution-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const fakeBin = join(sandbox, "bin");
    const logDirectory = join(sandbox, "logs");
    const checkout = join(home, "projects", "agentos");
    const oldRole = join(checkout, "agents", "firstmate");
    const distributionRoot = join(checkout, "packages", "agentos");
    const roleDirectory = join(
      distributionRoot,
      "resources",
      "roles",
      "firstmate",
    );
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
      mkdir(join(checkout, ".git"), { recursive: true }),
      mkdir(oldRole, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(checkout, "mise.toml"), "[tools]\n", "utf8"),
      writeFile(join(oldRole, "unfinished.md"), "keep me\n", "utf8"),
    ]);
    await Promise.all([
      makeExecutable(
        join(fakeBin, "mise"),
        `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "trust" && !(await Bun.file(args.at(-1)!).exists())) {
  process.exit(1);
}
await appendFile(
  join(process.env.FAKE_LOG_DIRECTORY!, "mise.log"),
  args.join(" ") + "\\n",
);
`,
      ),
      makeExecutable(
        join(fakeBin, "herdr"),
        `#!/usr/bin/env bun
if (process.argv.slice(2).join(" ") !== "integration install pi") process.exit(1);
`,
      ),
    ]);

    const result = await run(prepareHome, {
      AGENTOS_AGENT_CWD: roleDirectory,
      AGENTOS_AGENT_ROLE: "first_mate",
      AGENTOS_CHECKOUT: checkout,
      AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
      AGENTOS_RELEASE_ROOT: repository,
      FAKE_LOG_DIRECTORY: logDirectory,
      HOME: home,
      HERDR_CONFIG_PATH: join(home, ".config", "herdr", "config.toml"),
      MISE_SYSTEM_CONFIG_FILE: join(repository, "mise.toml"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    await expect(stat(roleDirectory)).resolves.toBeDefined();
    expect(await readFile(join(oldRole, "unfinished.md"), "utf8")).toBe(
      "keep me\n",
    );
  });

  test("does not infer a Mate distribution from the checkout or current directory", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-missing-distribution-"));
    temporaryDirectories.push(sandbox);
    const result = await run(prepareHome, {
      AGENTOS_AGENT_CWD: join(
        sandbox,
        "home",
        "projects",
        "agentos",
        "packages",
        "default",
        "resources",
        "roles",
        "firstmate",
      ),
      AGENTOS_AGENT_ROLE: "first_mate",
      AGENTOS_RELEASE_ROOT: repository,
      HOME: join(sandbox, "home"),
      PATH: process.env.PATH ?? "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AGENTOS_DISTRIBUTION_ROOT");
  });
});
