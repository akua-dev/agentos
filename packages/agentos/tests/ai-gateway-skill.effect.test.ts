import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

const readSkill = Effect.fn("test.aiGatewaySkill.read")(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const skillPath = yield* paths.fromFileUrl(
    new URL("../skills/agentos-ai-gateway/SKILL.md", import.meta.url),
  );
  return yield* fileSystem.readFileString(skillPath);
});

describe("AgentOS AI Gateway operator skill", () => {
  it.effect("orders every subscription-capacity posture from native to exceptional", () =>
    Effect.gen(function*() {
      const skill = yield* readSkill();
      const topologyLabels = Array.from(
        skill.matchAll(/^\|\s*[1-4]\s*\|\s*\*\*(.+?)\*\*\s*\|/gm),
        (match) => match[1],
      );

      assert.deepStrictEqual(topologyLabels, [
        "Direct per-Agent OAuth",
        "In-cluster multi-subscription Gateway",
        "Mixed in-cluster routing",
        "External Cloudflare Worker",
      ]);
      assert.isAbove(
        skill.indexOf("## External Cloudflare Worker"),
        skill.indexOf("## Verify, recover and retire"),
      );
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("defines a First Mate gateway-only recovery without disabling AgentOS behavior", () =>
    readSkill().pipe(
      Effect.tap((skill) => Effect.sync(() => {
        for (const expected of [
          "Gateway-only First Mate recovery",
          "models.json",
          "AI_GATEWAY_URL",
          "AGENTOS_EGRESS_TOKEN_FILE",
          "agentos.akua.dev/agentgateway-client",
          "@akua-dev/agentos",
          "agentos-observability",
          "mate-memory",
          "openai-server-compaction",
          "AGENTOS_OPENAI_SERVER_COMPACTION_ENABLED",
          "direct provider",
          "ai-gateway-direct-auth.yaml",
          "AGENTOS_PI_PROVIDER_MODE=direct",
          "pi-provider.json",
        ]) {
          assert.include(skill, expected);
        }
      })),
      Effect.provide(BunServices.layer),
    ));

  it.effect("uses projected workload identity without a shared inference Secret", () =>
    readSkill().pipe(
      Effect.tap((skill) => Effect.sync(() => {
        for (const expected of [
          "Secret/ai-gateway-operator",
          "agentgateway-openai.agentos.svc.cluster.local:8788",
          "before_provider_headers",
          "model_providers.agentos-gateway.auth",
          "refresh_interval_ms = 60000",
        ]) {
          assert.include(skill, expected);
        }
        assert.notInclude(skill, "Secret/ai-gateway-client");
        assert.notInclude(skill, "X-AI-Gateway-Token");
      })),
      Effect.provide(BunServices.layer),
    ));
});
