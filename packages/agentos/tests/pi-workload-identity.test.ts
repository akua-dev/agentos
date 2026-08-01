import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { registerPiWorkloadIdentity } from "../src/access/pi-workload-identity.ts";
import { createFakePi } from "./fake-pi.ts";

function configureGatewayModel(fake: ReturnType<typeof createFakePi>) {
  Object.assign(fake.context, {
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      baseUrl: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    },
  });
}

describe("Pi projected workload identity", () => {
  test("reads the kubelet-rotated token for every gateway request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-pi-identity-"));
    const tokenFile = join(directory, "token");
    const fake = createFakePi();
    configureGatewayModel(fake);
    registerPiWorkloadIdentity(fake.pi, {
      environment: {
        AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
        AGENTOS_ASSIGNMENT_ID:
          "20000000-0000-4000-8000-000000000001",
        AI_GATEWAY_URL:
          "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      },
      tokenFile,
    });

    try {
      await writeFile(tokenFile, "header.first.signature", { mode: 0o440 });
      const first: Record<string, string | null> = {
        Authorization: "Bearer static-placeholder",
        "x-ai-gateway-token": "legacy-shared-token",
        "X-AgentOS-Authz-Decision-Ref": "forged-decision",
      };
      await fake.emit("before_provider_headers", {
        type: "before_provider_headers",
        headers: first,
      });
      expect(first).toMatchObject({
        authorization: "Bearer header.first.signature",
        "x-ai-gateway-token": null,
        "x-agentos-assignment-id":
          "20000000-0000-4000-8000-000000000001",
      });
      expect(first.Authorization).toBeNull();
      expect(first["X-AgentOS-Authz-Decision-Ref"]).toBeNull();

      await chmod(tokenFile, 0o640);
      await writeFile(tokenFile, "header.rotated.signature");
      const rotated: Record<string, string | null> = {
        authorization: "Bearer static-placeholder",
      };
      await fake.emit("before_provider_headers", {
        type: "before_provider_headers",
        headers: rotated,
      });
      expect(rotated.authorization).toBe("Bearer header.rotated.signature");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("fails closed on an unavailable token and leaves direct providers untouched", async () => {
    const fake = createFakePi();
    configureGatewayModel(fake);
    registerPiWorkloadIdentity(fake.pi, {
      environment: {
        AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
        AI_GATEWAY_URL:
          "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      },
      tokenFile: "/missing/projected/token",
    });
    const missing: Record<string, string | null> = {
      authorization: "Bearer static-placeholder",
      "x-ai-gateway-token": "legacy-shared-token",
    };
    await fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: missing,
    });
    expect(missing.authorization).toBeNull();
    expect(missing["x-ai-gateway-token"]).toBeNull();

    Object.assign(fake.context, {
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "https://chatgpt.com/backend-api",
      },
    });
    const direct: Record<string, string | null> = {
      authorization: "Bearer direct-provider-token",
    };
    await fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: direct,
    });
    expect(direct.authorization).toBe("Bearer direct-provider-token");
  });
});
