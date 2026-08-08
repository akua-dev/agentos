import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Redacted } from "effect";

import {
  loadAIGatewayConfig,
  requireAIGatewayServeConfig,
} from "../src/config.ts";

function environment(values: Readonly<Record<string, string>>) {
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...values } }));
}

describe("AI Gateway Effect configuration", () => {
  it.effect("loads bounded defaults and keeps credentials redacted", () =>
    Effect.gen(function*() {
      const config = yield* loadAIGatewayConfig().pipe(
        Effect.provide(environment({
          HOME: "/home/agentos",
          AI_GATEWAY_TOKEN: "fleet-secret",
          OPENAI_API_KEY: "provider-secret",
        })),
      );

      assert.strictEqual(
        config.stateDirectory,
        "/home/agentos/.local/state/ai-gateway",
      );
      assert.strictEqual(config.hostname, "0.0.0.0");
      assert.strictEqual(config.port, 8787);
      assert.strictEqual(config.idleTimeoutSeconds, 255);
      assert.strictEqual(String(config.clientToken), "<redacted>");
      assert.strictEqual(String(config.openAIApiKey), "<redacted>");
      assert.strictEqual(Redacted.value(config.clientToken), "fleet-secret");
    }));

  it.effect("accepts workload identity without a shared client token", () =>
    Effect.gen(function*() {
      const config = yield* loadAIGatewayConfig().pipe(
        Effect.provide(environment({
          HOME: "/home/agentos",
          AI_GATEWAY_CLIENT_AUTH_MODE: "workload_identity",
          AI_GATEWAY_OPERATOR_TOKEN: "operator-only",
        })),
      );
      const serve = yield* requireAIGatewayServeConfig(config);

      assert.deepStrictEqual(serve.authentication, {
        kind: "workload_identity",
      });
      assert.strictEqual(
        Redacted.value(serve.operatorToken),
        "operator-only",
      );
    }));

  it.effect("loads an explicit Bun HTTP idle timeout", () =>
    Effect.gen(function*() {
      const configured = yield* loadAIGatewayConfig().pipe(
        Effect.provide(environment({
          HOME: "/home/agentos",
          AI_GATEWAY_IDLE_TIMEOUT_SECONDS: "120",
        })),
      );
      const disabled = yield* loadAIGatewayConfig().pipe(
        Effect.provide(environment({
          HOME: "/home/agentos",
          AI_GATEWAY_IDLE_TIMEOUT_SECONDS: "0",
        })),
      );

      assert.strictEqual(configured.idleTimeoutSeconds, 120);
      assert.strictEqual(disabled.idleTimeoutSeconds, 0);
    }));

  it.effect("rejects missing shared auth and malformed runtime bounds", () =>
    Effect.gen(function*() {
      const missingToken = yield* loadAIGatewayConfig().pipe(
        Effect.provide(environment({ HOME: "/home/agentos" })),
        Effect.flatMap(requireAIGatewayServeConfig),
        Effect.flip,
      );
      assert.strictEqual(missingToken.code, "client_identity_unavailable");

      const invalidEnvironments: ReadonlyArray<Readonly<Record<string, string>>> = [
        { AI_GATEWAY_LISTEN_PORT: "0" },
        { AI_GATEWAY_LISTEN_PORT: "65536" },
        { AI_GATEWAY_IDLE_TIMEOUT_SECONDS: "-1" },
        { AI_GATEWAY_IDLE_TIMEOUT_SECONDS: "256" },
        { AI_GATEWAY_HEARTBEAT_MILLIS: "0" },
        { AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TIMEOUT_MILLIS: "0" },
      ];
      for (const values of invalidEnvironments) {
        const failure = yield* loadAIGatewayConfig().pipe(
          Effect.provide(environment({ HOME: "/home/agentos", ...values })),
          Effect.flip,
        );
        assert.strictEqual(failure.code, "invalid_configuration");
      }
    }));
});
