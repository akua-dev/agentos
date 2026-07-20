import { describe, expect, test } from "bun:test";
import { createProxyHandler } from "../src/proxy.ts";
import type { RouteLease } from "../src/types.ts";

function request(path = "/responses", token = "fleet-token") {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "chatgpt-account-id": "inbound-must-not-survive",
      "session-id": "session-a",
    },
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
  });
}

describe("authenticated raw Responses proxy", () => {
  test("rejects an invalid client before acquiring a route", async () => {
    let acquired = false;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => {
        acquired = true;
        return undefined;
      },
      fetchImpl: fetch,
    });
    const response = await handler(request("/responses", "wrong"));
    expect(response.status).toBe(401);
    expect(acquired).toBe(false);
  });

  test("normalizes OAuth upstream headers/path and streams the real response", async () => {
    let upstream: Request | undefined;
    let released = false;
    const lease: RouteLease = {
      kind: "codex_oauth",
      accountId: "managed-a",
      providerAccountId: "provider-a",
      accessToken: "oauth-secret",
      leaseToken: "lease-a",
      renew: async () => true,
      release: async () => {
        released = true;
      },
    };
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async (sessionKey) => {
        expect(sessionKey).toBe("session-a");
        return lease;
      },
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("data: one\n\ndata: two\n\n", {
          status: 429,
          headers: { "content-type": "text/event-stream", "retry-after": "9" },
        });
      },
    });

    const response = await handler(request("/v1/responses"));
    expect(upstream?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstream?.headers.get("authorization")).toBe("Bearer oauth-secret");
    expect(upstream?.headers.get("chatgpt-account-id")).toBe("provider-a");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    await Bun.sleep(0);
    expect(released).toBe(true);
  });

  test("uses an API key only when acquisition explicitly selected the fallback", async () => {
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("ok");
      },
    });
    await handler(request("/codex/responses"));
    expect(upstream?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstream?.headers.get("authorization")).toBe("Bearer api-secret");
    expect(upstream?.headers.has("chatgpt-account-id")).toBe(false);
  });

  test("returns the upstream response even when local response bookkeeping fails", async () => {
    let released = false;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "codex_oauth",
        accountId: "managed-a",
        providerAccountId: "provider-a",
        accessToken: "oauth-secret",
        leaseToken: "lease-a",
        renew: async () => true,
        release: async () => {
          released = true;
        },
        recordResponse: async () => {
          throw new Error("state write failed");
        },
      }),
      fetchImpl: async () => new Response("real upstream body", { status: 429 }),
    });

    const response = await handler(request());
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("real upstream body");
    expect(released).toBe(true);
  });
});
