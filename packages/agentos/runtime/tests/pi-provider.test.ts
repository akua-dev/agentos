import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { reconcilePiConfiguration } from "../pi-provider.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentos-pi-provider-"));
  temporaryDirectories.push(root);
  const piAgentDirectory = join(root, "home", ".pi", "agent");
  const stateDirectory = join(root, "home", ".local", "state", "agentos");
  await Promise.all([
    mkdir(piAgentDirectory, { mode: 0o700, recursive: true }),
    mkdir(stateDirectory, { mode: 0o700, recursive: true }),
  ]);
  return {
    auth: join(piAgentDirectory, "auth.json"),
    marker: join(stateDirectory, "pi-provider.json"),
    models: join(piAgentDirectory, "models.json"),
    piAgentDirectory,
    settings: join(piAgentDirectory, "settings.json"),
    stateDirectory,
  };
}

function run(
  paths: Awaited<ReturnType<typeof fixture>>,
  environment: Record<string, string | undefined>,
) {
  return Effect.runPromise(
    reconcilePiConfiguration({
      environment,
      piAgentDirectory: paths.piAgentDirectory,
      stateDirectory: paths.stateDirectory,
    }),
  );
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

const gatewayEnvironment = {
  AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
  AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
  AGENTOS_THINKING: "xhigh",
  AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788/",
};

const managedGatewayProvider = {
  apiKey:
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder",
  baseUrl: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
};

describe("Pi provider reconciliation", () => {
  test("selects a native direct model on a fresh PVC without creating provider state", async () => {
    const paths = await fixture();

    await run(paths, {
      AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
      AGENTOS_PI_PROVIDER_MODE: "direct",
    });

    expect(await json(paths.settings)).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultProvider: "openai-codex",
    });
    expect(await Bun.file(paths.models).exists()).toBe(false);
    expect(await Bun.file(paths.marker).exists()).toBe(false);
  });

  test("creates a private native Gateway provider and exact selected defaults", async () => {
    const paths = await fixture();

    await run(paths, gatewayEnvironment);

    const models = await json(paths.models);
    expect(models.providers["openai-codex"]).toEqual(managedGatewayProvider);
    expect(await json(paths.settings)).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultProvider: "openai-codex",
      defaultThinkingLevel: "xhigh",
    });
    expect(await json(paths.marker)).toMatchObject({
      _tag: "Active",
      entry: models.providers["openai-codex"],
      version: 1,
    });
    for (const path of [paths.models, paths.settings, paths.marker]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(models)).not.toContain("AI_GATEWAY_TOKEN");
  });

  test("preserves unrelated providers, settings, and direct auth across idempotent retry", async () => {
    const paths = await fixture();
    const auth = { "openai-codex": { type: "oauth", access: "preserved" } };
    await Promise.all([
      writeJson(paths.auth, auth),
      writeJson(paths.models, {
        providers: {
          local: {
            api: "openai-completions",
            apiKey: "local",
            baseUrl: "http://localhost:11434/v1",
            models: [{ id: "qwen" }],
          },
        },
      }),
      writeJson(paths.settings, { theme: "agent-owned" }),
    ]);

    await run(paths, {
      AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
      AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    });
    const first = await Promise.all([
      readFile(paths.models, "utf8"),
      readFile(paths.settings, "utf8"),
      readFile(paths.marker, "utf8"),
    ]);
    await run(paths, {
      AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
      AI_GATEWAY_URL: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    });

    expect(await json(paths.auth)).toEqual(auth);
    expect(await json(paths.settings)).toEqual({ theme: "agent-owned" });
    expect((await json(paths.models)).providers.local.models).toEqual([
      { id: "qwen" },
    ]);
    expect(
      await Promise.all([
        readFile(paths.models, "utf8"),
        readFile(paths.settings, "utf8"),
        readFile(paths.marker, "utf8"),
      ]),
    ).toEqual(first);
  });

  test("removes only the marker-owned provider during explicit direct rollback", async () => {
    const paths = await fixture();
    await writeJson(paths.models, {
      providers: {
        local: {
          api: "openai-completions",
          apiKey: "local",
          baseUrl: "http://localhost:11434/v1",
          models: [{ id: "qwen" }],
        },
      },
    });
    await writeJson(paths.auth, {
      "openai-codex": { access: "preserved", type: "oauth" },
    });
    await run(paths, gatewayEnvironment);

    await run(paths, { AGENTOS_PI_PROVIDER_MODE: "direct" });

    const models = await json(paths.models);
    expect(models.providers.local.models).toEqual([{ id: "qwen" }]);
    expect(models.providers["openai-codex"]).toBeUndefined();
    expect(await Bun.file(paths.marker).exists()).toBe(false);
    expect(await json(paths.auth)).toEqual({
      "openai-codex": { access: "preserved", type: "oauth" },
    });
    expect(await json(paths.settings)).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultProvider: "openai-codex",
      defaultThinkingLevel: "xhigh",
    });
    await run(paths, { AGENTOS_PI_PROVIDER_MODE: "direct" });
    expect(await json(paths.models)).toEqual(models);
  });

  test("requires an explicit direct rollout before removing Gateway configuration", async () => {
    const paths = await fixture();
    await run(paths, gatewayEnvironment);

    await expect(run(paths, {})).rejects.toThrow(
      "must remain configured until direct rollback completes",
    );
    expect((await json(paths.models)).providers["openai-codex"]).toEqual(
      managedGatewayProvider,
    );
    expect(await json(paths.marker)).toMatchObject({ _tag: "Active" });
  });

  test("fails closed on an unowned provider collision before changing settings", async () => {
    const paths = await fixture();
    const models = {
      providers: {
        "openai-codex": { baseUrl: "https://user-proxy.example/v1" },
      },
    };
    const settings = { theme: "preserved" };
    await Promise.all([
      writeJson(paths.models, models),
      writeJson(paths.settings, settings),
    ]);

    await expect(run(paths, gatewayEnvironment)).rejects.toThrow(
      "openai-codex provider is not owned by AgentOS",
    );
    expect(await json(paths.models)).toEqual(models);
    expect(await json(paths.settings)).toEqual(settings);
    expect(await Bun.file(paths.marker).exists()).toBe(false);
  });

  test("finishes interrupted provider swaps and fails closed on divergent state", async () => {
    const beforeSwap = await fixture();
    await writeJson(beforeSwap.marker, {
      _tag: "Pending",
      desired: managedGatewayProvider,
      previous: null,
      version: 1,
    });

    await run(beforeSwap, gatewayEnvironment);
    expect((await json(beforeSwap.models)).providers["openai-codex"]).toEqual(
      managedGatewayProvider,
    );
    expect(await json(beforeSwap.marker)).toMatchObject({
      _tag: "Active",
      entry: managedGatewayProvider,
    });

    const afterSwap = await fixture();
    await Promise.all([
      writeJson(afterSwap.models, {
        providers: { "openai-codex": managedGatewayProvider },
      }),
      writeJson(afterSwap.marker, {
        _tag: "Pending",
        desired: managedGatewayProvider,
        previous: null,
        version: 1,
      }),
    ]);

    await run(afterSwap, gatewayEnvironment);
    expect(await json(afterSwap.marker)).toMatchObject({
      _tag: "Active",
      entry: managedGatewayProvider,
    });

    const divergent = await fixture();
    const userProvider = { baseUrl: "https://user-proxy.example/v1" };
    await Promise.all([
      writeJson(divergent.models, {
        providers: { "openai-codex": userProvider },
      }),
      writeJson(divergent.marker, {
        _tag: "Pending",
        desired: managedGatewayProvider,
        previous: null,
        version: 1,
      }),
    ]);

    await expect(run(divergent, gatewayEnvironment)).rejects.toThrow(
      "changed during an AgentOS reconciliation",
    );
    expect((await json(divergent.models)).providers["openai-codex"]).toEqual(
      userProvider,
    );
  });

  test("fails before writing on malformed JSON or incomplete Gateway inputs", async () => {
    const paths = await fixture();
    await writeFile(paths.settings, "[]\n", { mode: 0o600 });

    await expect(run(paths, gatewayEnvironment)).rejects.toThrow(
      "settings.json must contain a JSON object",
    );
    expect(await Bun.file(paths.models).exists()).toBe(false);
    expect(await Bun.file(paths.marker).exists()).toBe(false);

    await rm(paths.settings);
    await expect(
      run(paths, { AGENTOS_PI_PROVIDER_MODE: "ai-gateway" }),
    ).rejects.toThrow("AI_GATEWAY_URL must be configured");
    expect(await Bun.file(paths.models).exists()).toBe(false);

    await writeFile(paths.models, "{\n", { mode: 0o600 });
    await expect(run(paths, gatewayEnvironment)).rejects.toThrow(
      "models.json must contain valid JSON",
    );
    expect(await readFile(paths.models, "utf8")).toBe("{\n");
    expect(await Bun.file(paths.marker).exists()).toBe(false);
  });

  test("rejects unsupported modes, unsafe URLs, wrong providers, and unknown models", async () => {
    const paths = await fixture();
    await expect(
      run(paths, { AGENTOS_PI_PROVIDER_MODE: "automatic" }),
    ).rejects.toThrow("AGENTOS_PI_PROVIDER_MODE");
    await expect(
      run(paths, {
        ...gatewayEnvironment,
        AI_GATEWAY_URL: "file:///tmp/not-http",
      }),
    ).rejects.toThrow("AI_GATEWAY_URL must use http or https");
    await expect(
      run(paths, {
        ...gatewayEnvironment,
        AGENTOS_MODEL: "anthropic/claude-sonnet-4",
      }),
    ).rejects.toThrow("must select openai-codex");
    await expect(
      run(paths, {
        ...gatewayEnvironment,
        AGENTOS_MODEL: "openai-codex/model-that-does-not-exist",
      }),
    ).rejects.toThrow("is not a pinned Pi model");
    expect(await Bun.file(paths.models).exists()).toBe(false);
    expect(await Bun.file(paths.marker).exists()).toBe(false);
  });
});
