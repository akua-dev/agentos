import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { OAuthCredentials, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai/oauth";
import { runAIGatewayCli } from "../src/main.ts";

function credentials(accountId: string): OAuthCredentials {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return {
    access: `header.${payload}.access-secret`,
    refresh: "refresh-secret",
    expires: Date.now() + 3_600_000,
  };
}

describe("ai-gateway executable", () => {
  test("device login prints only the user-facing verification data and stores the account", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-cli-"));
    const lines: string[] = [];
    const result = await runAIGatewayCli(["login", "Team", "Primary"], {
      environment: { AI_GATEWAY_STATE_DIR: stateDirectory },
      writeLine: (line) => lines.push(line),
      login: async (options: { onDeviceCode(info: OAuthDeviceCodeInfo): void }) => {
        options.onDeviceCode({
          verificationUri: "https://example.test/device",
          userCode: "ABCD-EFGH",
        });
        return credentials("provider-a");
      },
      refresh: async () => credentials("provider-a"),
    });

    expect(result).toBe(0);
    expect(lines.join("\n")).toContain("https://example.test/device");
    expect(lines.join("\n")).toContain("ABCD-EFGH");
    expect(lines.join("\n")).toContain("Team Primary");
    expect(lines.join("\n")).not.toContain("access-secret");
    expect(lines.join("\n")).not.toContain("refresh-secret");

    const listLines: string[] = [];
    expect(
      await runAIGatewayCli(["list"], {
        environment: { AI_GATEWAY_STATE_DIR: stateDirectory },
        writeLine: (line) => listLines.push(line),
        login: async () => credentials("provider-a"),
        refresh: async () => credentials("provider-a"),
      }),
    ).toBe(0);
    expect(listLines.join("\n")).toContain("Team Primary");
    expect(listLines.join("\n")).not.toContain("provider-a");
  });

  test("serve fails closed before binding when the Fleet client token is absent", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-cli-"));
    const errors: string[] = [];
    const result = await runAIGatewayCli(["serve"], {
      environment: { AI_GATEWAY_STATE_DIR: stateDirectory },
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
      login: async () => credentials("provider-a"),
      refresh: async () => credentials("provider-a"),
      startServer: () => {
        throw new Error("must not bind");
      },
    });
    expect(result).toBe(1);
    expect(errors).toEqual(["AI_GATEWAY_TOKEN is required to serve"]);
  });

  test("binds the explicitly configured native listen address", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-listen-cli-"));
    let binding: { hostname: string; port: number } | undefined;
    const result = await runAIGatewayCli(["serve"], {
      environment: {
        AI_GATEWAY_LISTEN_HOST: "127.0.0.2",
        AI_GATEWAY_LISTEN_PORT: "9876",
        AI_GATEWAY_STATE_DIR: stateDirectory,
        AI_GATEWAY_TOKEN: "fleet-secret",
      },
      writeLine: () => undefined,
      login: async () => credentials("provider-a"),
      refresh: async () => credentials("provider-a"),
      startServer: ({ hostname, port }) => {
        binding = { hostname, port };
        return { stop: () => undefined };
      },
      waitForShutdown: async () => undefined,
    });

    expect(result).toBe(0);
    expect(binding).toEqual({ hostname: "127.0.0.2", port: 9876 });
  });

  test("ignores Kubernetes Service-link metadata as a listen-port choice", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-link-cli-"));
    let binding: { hostname: string; port: number } | undefined;
    const result = await runAIGatewayCli(["serve"], {
      environment: {
        AI_GATEWAY_PORT: "tcp://10.96.0.42:8787",
        AI_GATEWAY_STATE_DIR: stateDirectory,
        AI_GATEWAY_TOKEN: "fleet-secret",
      },
      writeLine: () => undefined,
      writeError: () => undefined,
      refresh: async () => credentials("provider-a"),
      startServer: ({ hostname, port }) => {
        binding = { hostname, port };
        return { stop: () => undefined };
      },
      waitForShutdown: async () => undefined,
    });

    expect(result).toBe(0);
    expect(binding).toEqual({ hostname: "0.0.0.0", port: 8787 });
  });

  test("status authenticates internally without putting the token in command arguments", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-cli-"));
    const lines: string[] = [];
    let authorization: string | null = null;
    const result = await runAIGatewayCli(["status"], {
      environment: {
        AI_GATEWAY_STATE_DIR: stateDirectory,
        AI_GATEWAY_TOKEN: "fleet-secret",
      },
      writeLine: (line) => lines.push(line),
      login: async () => credentials("provider-a"),
      refresh: async () => credentials("provider-a"),
      fetchImpl: async (input, init) => {
        authorization = new Request(String(input), init).headers.get("authorization");
        return Response.json({ accounts: [], apiKeyFallback: false });
      },
    });
    expect(result).toBe(0);
    expect(authorization as unknown).toBe("Bearer fleet-secret");
    expect(lines).toEqual(['{"accounts":[],"apiKeyFallback":false}']);
    expect(lines.join("\n")).not.toContain("fleet-secret");
  });
});
