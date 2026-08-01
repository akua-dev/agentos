import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { reconcileCodexProviderConfiguration } from "../codex-provider.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

async function fixture(initial = "") {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-provider-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, "home", ".codex");
  const stateDirectory = join(root, "home", ".local", "state", "agentos");
  await Promise.all([
    mkdir(codexHome, { mode: 0o700, recursive: true }),
    mkdir(stateDirectory, { mode: 0o700, recursive: true }),
  ]);
  const configPath = join(codexHome, "config.toml");
  if (initial) await writeFile(configPath, initial, { mode: 0o600 });
  return {
    configPath,
    markerPath: join(stateDirectory, "codex-provider.json"),
    stateDirectory,
  };
}

const gatewayEnvironment = {
  AGENTOS_ASSIGNMENT_ID: "20000000-0000-4000-8000-000000000001",
  AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
  AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
  AGENTOS_RELEASE_ROOT: "/opt/agentos",
  AI_GATEWAY_URL:
    "http://agentgateway-openai.agentos.svc.cluster.local:8788/",
  HOME: "/home/agent",
};

function reconcile(
  paths: Awaited<ReturnType<typeof fixture>>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return Effect.runPromise(
    reconcileCodexProviderConfiguration({
      configPath: paths.configPath,
      environment,
      stateDirectory: paths.stateDirectory,
    }),
  );
}

describe("Codex workload-authenticated provider", () => {
  test("owns a command-refreshed Gateway provider without persisting credentials", async () => {
    const paths = await fixture(
      [
        'model = "gpt-5.6-sol"',
        "",
        '[projects."/workspace"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );

    await reconcile(paths, gatewayEnvironment);

    const source = await readFile(paths.configPath, "utf8");
    const parsed = Bun.TOML.parse(source) as any;
    expect(parsed.model).toBe("gpt-5.6-sol");
    expect(parsed.model_provider).toBe("agentos-gateway");
    expect(parsed.projects).toEqual({
      "/workspace": { trust_level: "trusted" },
    });
    expect(parsed.model_providers["agentos-gateway"]).toEqual({
      name: "AgentOS workload gateway",
      base_url:
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      wire_api: "responses",
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 0,
      env_http_headers: {
        "X-AgentOS-Assignment-Id": "AGENTOS_ASSIGNMENT_ID",
      },
      auth: {
        command: "/home/agent/.local/share/mise/shims/bun",
        args: [
          "/opt/agentos/packages/agentos/runtime/codex-token.ts",
          "/var/run/secrets/agentos-egress/token",
        ],
        timeout_ms: 5_000,
        refresh_interval_ms: 60_000,
      },
    });
    expect(source).not.toContain("header.payload.signature");
    expect(source).not.toContain("AI_GATEWAY_TOKEN");
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.markerPath)).mode & 0o777).toBe(0o600);

    const first = await readFile(paths.configPath, "utf8");
    await reconcile(paths, gatewayEnvironment);
    expect(await readFile(paths.configPath, "utf8")).toBe(first);
  });

  test("restores the prior provider selection during explicit direct rollback", async () => {
    const paths = await fixture(
      [
        'model_provider = "user-provider"',
        "",
        "[model_providers.user-provider]",
        'name = "User provider"',
        'base_url = "https://provider.example/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
    );
    await reconcile(paths, gatewayEnvironment);

    await reconcile(paths, { AGENTOS_CODEX_PROVIDER_MODE: "direct" });

    const parsed = Bun.TOML.parse(
      await readFile(paths.configPath, "utf8"),
    ) as any;
    expect(parsed.model_provider).toBe("user-provider");
    expect(parsed.model_providers["user-provider"]).toMatchObject({
      name: "User provider",
    });
    expect(parsed.model_providers["agentos-gateway"]).toBeUndefined();
    expect(await Bun.file(paths.markerPath).exists()).toBe(false);
  });

  test("fails closed on ownership collisions and malformed identity inputs", async () => {
    const collision = await fixture(
      [
        "[model_providers.agentos-gateway]",
        'base_url = "https://user.example/v1"',
        "",
      ].join("\n"),
    );
    await expect(reconcile(collision, gatewayEnvironment)).rejects.toThrow(
      "not owned by AgentOS",
    );

    const malformed = await fixture('model = "gpt-5.6-sol"\n');
    await expect(
      reconcile(malformed, {
        ...gatewayEnvironment,
        AGENTOS_ASSIGNMENT_ID: "not-an-assignment",
      }),
    ).rejects.toThrow("AGENTOS_ASSIGNMENT_ID");
    expect(await readFile(malformed.configPath, "utf8")).toBe(
      'model = "gpt-5.6-sol"\n',
    );
  });

  const validationBin = process.env.AGENTOS_CODEX_VALIDATION_BIN;
  if (validationBin) {
    test("is accepted by the current Codex configuration loader", async () => {
      const paths = await fixture('model = "gpt-5.6-sol"\n');
      const home = join(paths.configPath, "..", "..");
      const shim = join(home, ".local", "share", "mise", "shims", "bun");
      const tokenFile = join(home, "projected-token");
      const releaseRoot = join(import.meta.dir, "..", "..", "..", "..");
      await mkdir(join(shim, ".."), { recursive: true });
      await symlink(Bun.which("bun")!, shim);
      await writeFile(tokenFile, "header.payload.signature", { mode: 0o400 });
      await reconcile(paths, {
        ...gatewayEnvironment,
        AGENTOS_EGRESS_TOKEN_FILE: tokenFile,
        AGENTOS_RELEASE_ROOT: releaseRoot,
        HOME: home,
      });

      const child = Bun.spawn(
        [validationBin, "debug", "models"],
        {
          env: {
            ...process.env,
            CODEX_HOME: join(paths.configPath, ".."),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Codex rejected the managed provider: ${stderr}`);
      }
      expect(stderr).not.toContain("Failed to load");
      expect(stderr).not.toContain("config.toml");
    }, 15_000);
  }
});
