import { describe, expect, test } from "bun:test";
import {
  providerAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";

import { createProxyHandler } from "../src/proxy.ts";

const now = 1_785_586_000_000;
const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";

function grant(
  capability: ProviderAuthorizationGrantV1["capability"] =
    "openai.responses.create",
): ProviderAuthorizationGrantV1 {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    expiresAtMillis: now + 15_000,
    credentialDomain: "openai-responses",
    identity: {
      agentId: AgentId,
      role: "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId: AssignmentId,
    },
    capability,
    resource: {
      kind: "provider_service",
      provider: "openai",
      service: "responses",
    },
    profile: { profileId: "openai-responses", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  };
}

function request(
  path = "/v1/responses",
  authorization = grant(),
): Request {
  const headers = providerAuthorizationGrantHeaders(authorization);
  headers.set("authorization", "Bearer projected-workload-jwt");
  headers.set("content-type", "application/json");
  headers.set("session-id", "conversation-a");
  return new Request(`http://ai-gateway.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
  });
}

describe("AI Gateway workload-identity client authorization", () => {
  test("attributes an authorized Assignment before routing and strips every identity header upstream", async () => {
    let attribution: ProviderAuthorizationGrantV1 | undefined;
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientAuthentication: { kind: "workload_identity", clock: () => now },
      acquire: async (_sessionKey, _signal, _telemetry, grant) => {
        attribution = grant;
        return {
          kind: "openai_api_key",
          accountId: "openai-api-key",
          accessToken: "provider-secret",
          leaseToken: "api-key",
          renew: async () => true,
          release: async () => undefined,
        };
      },
      fetchImpl: async (input, init) => {
        upstream = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        );
        return new Response("ok");
      },
    });

    const response = await handler(request());
    expect(await response.text()).toBe("ok");
    expect(attribution?.identity).toEqual(grant().identity);
    expect(attribution?.profile).toEqual(grant().profile);
    expect(upstream?.headers.get("authorization")).toBe(
      "Bearer provider-secret",
    );
    expect(
      [...(upstream?.headers.keys() ?? [])].filter((name) =>
        name.startsWith("x-agentos-authz-")
      ),
    ).toEqual([]);
    expect(JSON.stringify([...upstream!.headers])).not.toContain(
      "projected-workload-jwt",
    );
  });

  test("fails before route acquisition for expired, overlong, mismatched, missing, and disabled grants", async () => {
    let acquireCalls = 0;
    const handler = createProxyHandler({
      clientAuthentication: { kind: "workload_identity", clock: () => now },
      acquire: async () => {
        acquireCalls += 1;
        return undefined;
      },
      fetchImpl: async () => new Response("unexpected"),
    });

    const expired = { ...grant(), expiresAtMillis: now };
    expect((await handler(request("/v1/responses", expired))).status).toBe(
      401,
    );
    const overlong = { ...grant(), expiresAtMillis: now + 15_001 };
    expect((await handler(request("/v1/responses", overlong))).status).toBe(
      401,
    );
    expect(
      (await handler(
        request("/v1/responses/compact", grant("openai.responses.create")),
      )).status,
    ).toBe(403);
    const missing = request();
    missing.headers.delete("x-agentos-authz-decision-ref");
    expect((await handler(missing)).status).toBe(401);
    const disabled = { ...grant(), rateClass: "disabled" as const };
    expect((await handler(request("/v1/responses", disabled))).status).toBe(
      403,
    );
    expect(acquireCalls).toBe(0);
  });

  test("keeps the legacy shared-token rollback mode explicit", async () => {
    let attribution: ProviderAuthorizationGrantV1 | undefined;
    const handler = createProxyHandler({
      clientAuthentication: { kind: "shared_token", token: "rollback-token" },
      acquire: async (_sessionKey, _signal, _telemetry, grant) => {
        attribution = grant;
        return undefined;
      },
      fetchImpl: fetch,
    });
    const legacy = new Request("http://ai-gateway.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer rollback-token" },
    });
    expect((await handler(legacy)).status).toBe(503);
    expect(attribution).toBeUndefined();
  });
});
