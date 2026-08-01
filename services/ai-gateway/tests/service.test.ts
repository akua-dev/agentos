import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  providerAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";
import { createAIGatewayService } from "../src/service.ts";
import type { GatewayTelemetry } from "../src/telemetry.ts";

function accessToken(accountId: string, suffix = ""): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature${suffix}`;
}

function credentials(accountId: string, suffix = ""): OAuthCredentials {
  return {
    access: accessToken(accountId, suffix),
    refresh: "refresh-secret",
    expires: Date.now() + 3_600_000,
  };
}

function proxyRequest(path = "/responses", token = "fleet-token") {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
  });
}

function workloadRequest(
  now: number,
  assignmentId = "20000000-0000-4000-8000-000000000001",
) {
  const grant: ProviderAuthorizationGrantV1 = {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    expiresAtMillis: now + 15_000,
    credentialDomain: "openai-responses",
    identity: {
      agentId: "10000000-0000-4000-8000-000000000001",
      role: "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId,
    },
    capability: "openai.responses.create",
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
  const headers = providerAuthorizationGrantHeaders(grant);
  headers.set("authorization", "Bearer projected-workload-token");
  headers.set("content-type", "application/json");
  headers.set("session-id", "fresh-session");
  return new Request("http://gateway.test/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
  });
}

describe("AI gateway service", () => {
  test("boots a fresh workload-identity PVC, stays unready until login, then dispatches an authorized Assignment", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-workload-service-"));
    const now = Date.now();
    let upstreamAuthorization: string | null = null;
    const service = await createAIGatewayService({
      stateDirectory,
      clientAuthentication: { kind: "workload_identity", clock: () => now },
      operatorToken: "operator-only",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      clock: () => now,
      fetchImpl: async (input, init) => {
        if (String(input).includes("wham/usage")) {
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_at: Math.floor((now + 3_600_000) / 1_000),
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 604_800,
                reset_at: Math.floor((now + 86_400_000) / 1_000),
              },
            },
          });
        }
        upstreamAuthorization = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        ).headers.get("authorization");
        return new Response("authorized");
      },
    });

    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(503);
    expect((await service.fetch(proxyRequest())).status).toBe(401);
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));
    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(200);

    const response = await service.fetch(workloadRequest(now));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("authorized");
    expect(upstreamAuthorization as unknown).toBe(
      `Bearer ${accessToken("provider-a")}`,
    );
    expect(
      (
        await service.fetch(
          new Request("http://gateway.test/status", {
            headers: { authorization: "Bearer operator-only" },
          }),
        )
      ).status,
    ).toBe(200);
    await service.close();
  });

  test("keeps health public, readiness honest, and status authenticated", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      fetchImpl: fetch,
    });

    expect(
      (await service.fetch(new Request("http://gateway.test/healthz"))).status,
    ).toBe(200);
    const emptyReadiness = await service.fetch(
      new Request("http://gateway.test/readyz"),
    );
    expect(emptyReadiness.status).toBe(503);
    expect(await emptyReadiness.json()).toEqual({
      reasons: ["provider_credential_unavailable"],
      status: "not_ready",
      version: 1,
    });
    expect(
      (
        await service.fetch(
          new Request("http://gateway.test/readyz/client"),
        )
      ).status,
    ).toBe(401);
    expect(
      (await service.fetch(new Request("http://gateway.test/status"))).status,
    ).toBe(401);
    expect(
      (
        await service.fetch(
          new Request("http://gateway.test/status", {
            headers: { "x-ai-gateway-token": "fleet-token" },
          }),
        )
      ).status,
    ).toBe(200);

    const accountId = await service.vault.addFromOAuth(
      "Primary",
      credentials("provider-a"),
    );
    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(200);
    const clientReadiness = await service.fetch(
      new Request("http://gateway.test/readyz/client", {
        headers: { authorization: "Bearer fleet-token" },
      }),
    );
    expect(clientReadiness.status).toBe(200);
    expect(await clientReadiness.json()).toEqual({
      reasons: ["provider_capacity_unknown"],
      status: "degraded",
      version: 1,
    });
    await service.vault.markNeedsReauth(accountId);
    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(503);

    const unavailable = await service.fetch(proxyRequest());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "no_eligible_account" });
    const protectedStatus = await service.fetch(
      new Request("http://gateway.test/status", {
        headers: { authorization: "Bearer fleet-token" },
      }),
    );
    expect(await protectedStatus.json()).toMatchObject({
      routing: {
        lastSelection: {
          reason: "no_eligible_accounts",
          candidates: [
            {
              accountId,
              eligible: false,
              freshness: "unknown",
              rejectionCode: "reauthentication_required",
            },
          ],
        },
      },
    });
    await service.close();
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
        if (String(input).includes("wham/usage"))
          throw new Error("unexpected usage request");
        upstreamAuth = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        ).headers.get("authorization");
        return new Response("fallback-ok");
      },
    });

    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(200);
    expect(await (await service.fetch(proxyRequest())).text()).toBe(
      "fallback-ok",
    );
    expect(upstreamAuth as unknown).toBe("Bearer api-secret");
    const status = await service.fetch(
      new Request("http://gateway.test/status", {
        headers: { authorization: "Bearer fleet-token" },
      }),
    );
    const body = await status.text();
    const parsed = JSON.parse(body) as {
      apiKeyFallback: boolean;
      routing?: {
        activeReservations: number;
        reservationsByAccount: Record<string, number>;
      };
    };
    expect(parsed.apiKeyFallback).toBe(true);
    expect(parsed.routing).toMatchObject({
      activeReservations: 0,
      reservationsByAccount: {},
      lastSelection: { reason: "no_eligible_accounts" },
    });
    expect(body).not.toContain("api-secret");
    await service.close();
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
          new Request(
            input instanceof Request ? input.url : input.toString(),
            init,
          ).headers.get("authorization"),
        ).toBe(`Bearer ${accessToken("provider-a")}`);
        return new Response("quota reached", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
    });
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));

    const first = await service.fetch(proxyRequest());
    expect(first.status).toBe(429);
    expect(await first.text()).toBe("quota reached");
    const second = await service.fetch(proxyRequest());
    expect(second.status).toBe(503);
    expect(responseCalls).toBe(1);
    const degraded = await service.fetch(
      new Request("http://gateway.test/readyz"),
    );
    expect(degraded.status).toBe(200);
    expect(await degraded.json()).toEqual({
      reasons: ["provider_capacity_degraded"],
      status: "degraded",
      version: 1,
    });
    await service.close();
  });

  test("records bounded quota observation age and freshness during acquisition", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    let now = 1_000_000;
    const observations: Array<[number, boolean]> = [];
    let usageCalls = 0;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a") },
      clock: () => now,
      telemetry: recordingQuotaTelemetry(observations),
      fetchImpl: async (input) => {
        if (String(input).includes("wham/usage")) {
          usageCalls += 1;
          if (usageCalls === 2) throw new Error("usage unavailable");
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_at: Math.floor((now + 3_600_000) / 1_000),
              },
              secondary_window: {
                used_percent: 20,
                limit_window_seconds: 604_800,
                reset_at: Math.floor((now + 86_400_000) / 1_000),
              },
            },
          });
        }
        return new Response("ok");
      },
    });
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));

    expect((await service.fetch(proxyRequest())).status).toBe(200);
    now += 61_000;
    expect((await service.fetch(proxyRequest())).status).toBe(200);

    expect(observations).toEqual([
      [0, false],
      [61, true],
    ]);
    await service.close();
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
    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(200);

    const recovered = await service.fetch(proxyRequest());
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("recovered");
    expect(responseCalls).toBe(2);
    await service.close();
  });

  test("does not let a late usage 401 invalidate a fresh same-account login", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
    let releaseUsageProbe!: () => void;
    let usageProbeStarted!: () => void;
    const usageProbeGate = new Promise<void>((resolve) => {
      releaseUsageProbe = resolve;
    });
    const usageProbeStartedSignal = new Promise<void>((resolve) => {
      usageProbeStarted = resolve;
    });
    let usageCalls = 0;
    let responseCalls = 0;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: false,
      oauth: { refresh: async () => credentials("provider-a", "-refresh") },
      fetchImpl: async (input, init) => {
        const request = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        );
        if (request.url.includes("wham/usage")) {
          usageCalls += 1;
          if (usageCalls === 1) {
            expect(request.headers.get("authorization")).toBe(
              `Bearer ${accessToken("provider-a")}`,
            );
            usageProbeStarted();
            await usageProbeGate;
            return new Response("expired credential", { status: 401 });
          }
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${accessToken("provider-a", "-fresh")}`,
          );
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
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken("provider-a", "-fresh")}`,
        );
        return new Response("recovered", { status: 200 });
      },
    });
    await service.vault.addFromOAuth("Primary", credentials("provider-a"));

    const inFlightProbe = service.fetch(proxyRequest());
    await usageProbeStartedSignal;
    await service.vault.addFromOAuth(
      "Primary",
      credentials("provider-a", "-fresh"),
    );
    releaseUsageProbe();

    expect((await inFlightProbe).status).toBe(503);
    expect(
      (await service.fetch(new Request("http://gateway.test/readyz"))).status,
    ).toBe(200);

    const recovered = await service.fetch(proxyRequest());
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("recovered");
    expect(usageCalls).toBe(2);
    expect(responseCalls).toBe(1);
    await service.close();
  });
});

function recordingQuotaTelemetry(
  observations: Array<[number, boolean]>,
): GatewayTelemetry {
  return {
    enabled: true,
    startRequest() {
      return {
        attemptId: "gateway-test",
        authenticate() {},
        routeStarted() {},
        routeEnded() {},
        quotaObservation(ageSeconds, stale) {
          observations.push([ageSeconds, stale]);
        },
        upstreamStarted() {},
        upstreamHeaders() {},
        upstreamFailed() {},
        streamChunk() {},
        routeReleaseStarted() {},
        routeReleased() {},
        end() {},
      };
    },
  };
}
