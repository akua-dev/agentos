import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { createAIGatewayService } from "../src/service.ts";

function accessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function credentials(accountId: string): OAuthCredentials {
  return { access: accessToken(accountId), refresh: "refresh-secret", expires: Date.now() + 3_600_000 };
}

function proxyRequest(path = "/responses", token = "fleet-token") {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
  });
}

describe("AI gateway service", () => {
  test("keeps health public, readiness honest, and status authenticated", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      fetchImpl: fetch,
    });

    expect((await service.fetch(new Request("http://gateway.test/healthz"))).status).toBe(200);
    expect((await service.fetch(new Request("http://gateway.test/readyz"))).status).toBe(503);
    expect((await service.fetch(new Request("http://gateway.test/status"))).status).toBe(401);
    expect(
      (
        await service.fetch(
          new Request("http://gateway.test/status", {
            headers: { "x-ai-gateway-token": "fleet-token" },
          }),
        )
      ).status,
    ).toBe(200);

    const accountId = await service.vault.addFromOAuth("Primary", credentials("provider-a"));
    expect((await service.fetch(new Request("http://gateway.test/readyz"))).status).toBe(200);
    await service.vault.markNeedsReauth(accountId);
    expect((await service.fetch(new Request("http://gateway.test/readyz"))).status).toBe(503);
  });

  test("uses the explicitly enabled API-key fallback without storing it in status", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    let upstreamAuth: string | null = null;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: true,
      openAIApiKey: "api-secret",
      oauth: { refresh: async () => credentials("provider-a") },
      fetchImpl: async (input, init) => {
        if (String(input).includes("wham/usage")) throw new Error("unexpected usage request");
        upstreamAuth = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        ).headers.get("authorization");
        return new Response("fallback-ok");
      },
    });

    expect((await service.fetch(new Request("http://gateway.test/readyz"))).status).toBe(200);
    expect(await (await service.fetch(proxyRequest())).text()).toBe("fallback-ok");
    expect(upstreamAuth as unknown).toBe("Bearer api-secret");
    const status = await service.fetch(
      new Request("http://gateway.test/status", {
        headers: { authorization: "Bearer fleet-token" },
      }),
    );
    const body = await status.text();
    const parsed = JSON.parse(body) as {
      apiKeyFallback: boolean;
      routing?: { activeReservations: number; reservationsByAccount: Record<string, number> };
    };
    expect(parsed.apiKeyFallback).toBe(true);
    expect(parsed.routing).toEqual({ activeReservations: 0, reservationsByAccount: {} });
    expect(body).not.toContain("api-secret");
  });

  test("routes through an OAuth account and makes a visible 429 ineligible for the next request", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    let responseCalls = 0;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      fetchImpl: async (input, init) => {
        if (String(input).includes("wham/usage")) {
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_at: Math.floor((Date.now() + 3_600_000) / 1_000),
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 604_800,
                reset_at: Math.floor((Date.now() + 86_400_000) / 1_000),
              },
            },
          });
        }
        responseCalls += 1;
        expect(
          new Request(input instanceof Request ? input.url : input.toString(), init).headers.get(
            "authorization",
          ),
        ).toBe(
          `Bearer ${accessToken("provider-a")}`,
        );
        return new Response("quota reached", { status: 429, headers: { "retry-after": "60" } });
      },
    });
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));

    const first = await service.fetch(proxyRequest());
    expect(first.status).toBe(429);
    expect(await first.text()).toBe("quota reached");
    const second = await service.fetch(proxyRequest());
    expect(second.status).toBe(503);
    expect(responseCalls).toBe(1);
  });

  test("recovers the same OAuth account after a visible 401 and fresh login", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    let responseCalls = 0;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      fetchImpl: async (input) => {
        if (String(input).includes("wham/usage")) {
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_at: Math.floor((Date.now() + 3_600_000) / 1_000),
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 604_800,
                reset_at: Math.floor((Date.now() + 86_400_000) / 1_000),
              },
            },
          });
        }
        responseCalls += 1;
        return responseCalls === 1
          ? new Response("expired credential", { status: 401 })
          : new Response("recovered", { status: 200 });
      },
    });
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));

    const rejected = await service.fetch(proxyRequest());
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toBe("expired credential");

    await service.vault.addFromOAuth("Primary", credentials("provider-a"));
    expect((await service.fetch(new Request("http://gateway.test/readyz"))).status).toBe(200);

    const recovered = await service.fetch(proxyRequest());
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("recovered");
    expect(responseCalls).toBe(2);
  });
});
