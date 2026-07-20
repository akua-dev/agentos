import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildQuotaRouterProvider, configureQuotaRouter } from "../extension.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const installedModels = [
  {
    id: "gpt-test",
    name: "Installed Codex model",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
  {
    id: "other",
    name: "Other provider model",
    provider: "other-provider",
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  },
] satisfies Model<Api>[];

describe("Pi Fleet Codex provider", () => {
  test("is inert unless both the endpoint and client token are configured", () => {
    expect(buildQuotaRouterProvider({}, installedModels)).toBeUndefined();
    expect(
      buildQuotaRouterProvider(
        { QUOTA_ROUTER_URL: "http://quota-router:8787" },
        installedModels,
      ),
    ).toBeUndefined();
    expect(
      buildQuotaRouterProvider({ QUOTA_ROUTER_TOKEN: "client-secret" }, installedModels),
    ).toBeUndefined();
  });

  test("registers an explicit provider from Pi's installed Codex catalog", () => {
    let registration:
      | { name: string; config: Parameters<ExtensionAPI["registerProvider"]>[1] }
      | undefined;
    const pi = {
      registerProvider(name: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
        registration = { name, config };
      },
    } as unknown as ExtensionAPI;

    configureQuotaRouter(
      pi,
      installedModels,
      {
        QUOTA_ROUTER_URL: "http://quota-router.agentos.svc:8787/",
        QUOTA_ROUTER_TOKEN: "client-secret",
      },
    );

    expect(registration?.name).toBe("fleet-codex");
    expect(registration?.config.name).toBe("Fleet Codex");
    expect(registration?.config.baseUrl).toBe("http://quota-router.agentos.svc:8787");
    expect(registration?.config.models?.map((model) => model.id)).toEqual(["gpt-test"]);
  });

  test("keeps the Fleet secret in a dedicated native header", () => {
    const config = buildQuotaRouterProvider(
      {
        QUOTA_ROUTER_URL: "http://quota-router:8787",
        QUOTA_ROUTER_TOKEN: "client-secret",
      },
      installedModels,
    );

    expect(config?.headers).toEqual({ "X-Quota-Router-Token": "$QUOTA_ROUTER_TOKEN" });
    expect(config?.apiKey).not.toContain("client-secret");
    expect(config?.streamSimple).toBeUndefined();
  });

  test("auto-loads through Pi and exposes the installed Fleet Codex models", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "agentos-pi-quota-router-"));
    temporaryDirectories.push(agentDirectory);
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    await writeFile(
      join(agentDirectory, "trust.json"),
      `${JSON.stringify({ [repositoryRoot]: true })}\n`,
    );
    const child = Bun.spawn(
      ["pi", "--mode", "rpc", "--no-session", "--offline", "--no-skills", "--no-prompt-templates"],
      {
        cwd: join(repositoryRoot, "agents/firstmate"),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDirectory,
          QUOTA_ROUTER_URL: "http://quota-router.agentos.svc:8787",
          QUOTA_ROUTER_TOKEN: "test-client-token",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(
      `${JSON.stringify({ id: "models", type: "get_available_models" })}\n`,
    );
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const response = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((message) => message.id === "models");
    expect(response?.success).toBe(true);
    expect(
      response.data.models.some(
        (model: { provider: string; id: string }) =>
          model.provider === "fleet-codex" && model.id.length > 0,
      ),
    ).toBe(true);
    expect(stdout).not.toContain("test-client-token");
  });
});
