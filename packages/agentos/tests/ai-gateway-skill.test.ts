import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const skillPath = join(
  import.meta.dir,
  "..",
  "skills",
  "agentos-ai-gateway",
  "SKILL.md",
);

describe("AgentOS AI Gateway operator skill", () => {
  test("orders every subscription-capacity posture from native to exceptional", async () => {
    const skill = await readFile(skillPath, "utf8");
    const topologyLabels = Array.from(
      skill.matchAll(/^\|\s*[1-4]\s*\|\s*\*\*(.+?)\*\*\s*\|/gm),
      (match) => match[1],
    );

    expect(topologyLabels).toEqual([
      "Direct per-Agent OAuth",
      "In-cluster multi-subscription Gateway",
      "Mixed in-cluster routing",
      "External Cloudflare Worker",
    ]);
    expect(skill.indexOf("## External Cloudflare Worker")).toBeGreaterThan(
      skill.indexOf("## Verify, recover and retire"),
    );
  });

  test("defines a First Mate gateway-only recovery without disabling AgentOS behavior", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain("Gateway-only First Mate recovery");
    expect(skill).toContain("models.json");
    expect(skill).toContain("AI_GATEWAY_URL");
    expect(skill).toContain("AGENTOS_EGRESS_TOKEN_FILE");
    expect(skill).toContain("agentos.akua.dev/agentgateway-client");
    expect(skill).toContain("@akua-dev/agentos");
    expect(skill).toContain("agentos-observability");
    expect(skill).toContain("mate-memory");
    expect(skill).toContain("openai-server-compaction");
    expect(skill).toContain("AGENTOS_OPENAI_SERVER_COMPACTION_ENABLED");
    expect(skill).toContain("direct provider");
    expect(skill).toContain("ai-gateway-direct-auth.yaml");
    expect(skill).toContain("AGENTOS_PI_PROVIDER_MODE=direct");
    expect(skill).toContain("pi-provider.json");
  });

  test("uses projected workload identity without a shared inference Secret", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain("Secret/ai-gateway-operator");
    expect(skill).toContain("agentgateway-openai.agentos.svc.cluster.local:8788");
    expect(skill).toContain("before_provider_headers");
    expect(skill).toContain("model_providers.agentos-gateway.auth");
    expect(skill).toContain("refresh_interval_ms = 60000");
    expect(skill).not.toContain("Secret/ai-gateway-client");
    expect(skill).not.toContain("X-AI-Gateway-Token");
  });
});
