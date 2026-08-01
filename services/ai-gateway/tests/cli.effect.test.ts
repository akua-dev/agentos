import { assert, describe, it } from "@effect/vitest";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  ConfigProvider,
  Effect,
  Layer,
  Redacted,
  Ref,
} from "effect";

import {
  AIGatewayCliOutput,
  AIGatewayOAuth,
  AIGatewayRuntime,
  AIGatewayStatusClient,
  runAIGatewayCli,
} from "../src/cli.ts";
import {
  type AIGatewayConfig,
  loadAIGatewayConfig,
} from "../src/config.ts";
import { ManagedAccountVault } from "../src/state.ts";

function credentials(accountId: string): OAuthCredentials {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return {
    access: `header.${payload}.access-secret`,
    refresh: "refresh-secret",
    expires: 4_000_000,
  };
}

function configuration(
  changes: Partial<AIGatewayConfig> = {},
): AIGatewayConfig {
  return {
    stateDirectory: "/state",
    hostname: "0.0.0.0",
    port: 8787,
    gracefulShutdownMillis: 20_000,
    clientAuthenticationMode: "shared_token",
    clientToken: Redacted.make("fleet-secret"),
    operatorToken: Redacted.make(""),
    allowApiKeyFallback: false,
    openAIApiKey: Redacted.make(""),
    heartbeatMillis: 40_000,
    maximumUsageEventBytes: 256 * 1_024,
    usageCacheMillis: 60_000,
    quotaTimeoutMillis: 5_000,
    settlementBaseUrl:
      "http://agentos-egress-authz.agentos.svc.cluster.local:9001",
    settlementTokenPath:
      "/var/run/secrets/agentos-budget-settlement/token",
    settlementTimeoutMillis: 2_000,
    settlementMaximumResponseBytes: 1_024,
    ...changes,
  };
}

const makeHarness = Effect.fn("test.aiGateway.makeCliHarness")(function*() {
  const output = yield* Ref.make<ReadonlyArray<string>>([]);
  const errors = yield* Ref.make<ReadonlyArray<string>>([]);
  const accounts = yield* Ref.make<ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly needsReauth: boolean;
    readonly expiresAt: number;
  }>>([]);
  const served = yield* Ref.make<ReadonlyArray<{
    readonly hostname: string;
    readonly port: number;
    readonly authentication: string;
  }>>([]);
  const statusTokens = yield* Ref.make<ReadonlyArray<string>>([]);
  const line = (value: string) =>
    Ref.update(output, (values) => [...values, value]);
  const error = (value: string) =>
    Ref.update(errors, (values) => [...values, value]);
  const layer = Layer.mergeAll(
    Layer.succeed(AIGatewayCliOutput)(AIGatewayCliOutput.of({ line, error })),
    Layer.succeed(AIGatewayOAuth)(AIGatewayOAuth.of({
      login: (onDeviceCode) =>
        Effect.gen(function*() {
          yield* onDeviceCode({
            verificationUri: "https://example.test/device",
            userCode: "ABCD-EFGH",
          });
          return credentials("provider-a");
        }),
    })),
    Layer.succeed(ManagedAccountVault)(ManagedAccountVault.of({
      list: Ref.get(accounts),
      addFromOAuth: (label) =>
        Ref.update(accounts, (values) => [
          ...values,
          {
            id: "opaque-id",
            label,
            needsReauth: false,
            expiresAt: 4_000_000,
          },
        ]).pipe(Effect.as("opaque-id")),
      getFreshCredential: () => Effect.die("unused"),
      remove: (id) =>
        Ref.modify(accounts, (values) => {
          const retained = values.filter((account) => account.id !== id);
          return [retained.length !== values.length, retained];
        }),
      markNeedsReauth: () => Effect.die("unused"),
    })),
    Layer.succeed(AIGatewayRuntime)(AIGatewayRuntime.of({
      serve: (config) =>
        Ref.update(served, (values) => [
          ...values,
          {
            hostname: config.hostname,
            port: config.port,
            authentication: config.authentication.kind,
          },
        ]),
    })),
    Layer.succeed(AIGatewayStatusClient)(AIGatewayStatusClient.of({
      read: (_port, token) =>
        Ref.update(
          statusTokens,
          (values) => [...values, Redacted.value(token)],
        ).pipe(Effect.as('{"accounts":[],"apiKeyFallback":false}')),
    })),
  );
  return { output, errors, accounts, served, statusTokens, layer };
});

describe("AI Gateway Effect CLI", () => {
  it.effect("prints only device verification data and stores an opaque account", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      assert.strictEqual(
        yield* runAIGatewayCli(
          ["login", "Team", "Primary"],
          configuration(),
        ).pipe(Effect.provide(harness.layer)),
        0,
      );
      assert.strictEqual(
        yield* runAIGatewayCli(["list"], configuration()).pipe(
          Effect.provide(harness.layer),
        ),
        0,
      );
      const lines = (yield* Ref.get(harness.output)).join("\n");
      assert.include(lines, "https://example.test/device");
      assert.include(lines, "ABCD-EFGH");
      assert.include(lines, "Team Primary");
      assert.notInclude(lines, "access-secret");
      assert.notInclude(lines, "refresh-secret");
      assert.notInclude(lines, "provider-a");
    }));

  it.effect("fails closed before serving when shared client identity is absent", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      const exitCode = yield* runAIGatewayCli(
        ["serve"],
        configuration({ clientToken: Redacted.make("") }),
      ).pipe(Effect.provide(harness.layer));
      assert.strictEqual(exitCode, 1);
      assert.deepStrictEqual(yield* Ref.get(harness.served), []);
      assert.deepStrictEqual(yield* Ref.get(harness.errors), [
        "AI_GATEWAY_TOKEN is required to serve",
      ]);
    }));

  it.effect("passes the explicit native bind address to the Effect runtime", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      const exitCode = yield* runAIGatewayCli(
        ["serve"],
        configuration({ hostname: "127.0.0.2", port: 9876 }),
      ).pipe(Effect.provide(harness.layer));
      assert.strictEqual(exitCode, 0);
      assert.deepStrictEqual(yield* Ref.get(harness.served), [{
        hostname: "127.0.0.2",
        port: 9876,
        authentication: "shared_token",
      }]);
    }));

  it.effect("serves workload identity without a shared client token", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      const exitCode = yield* runAIGatewayCli(
        ["serve"],
        configuration({
          clientAuthenticationMode: "workload_identity",
          clientToken: Redacted.make(""),
          operatorToken: Redacted.make("operator-only"),
        }),
      ).pipe(Effect.provide(harness.layer));
      assert.strictEqual(exitCode, 0);
      assert.deepStrictEqual(yield* Ref.get(harness.served), [{
        hostname: "0.0.0.0",
        port: 8787,
        authentication: "workload_identity",
      }]);
    }));

  it.effect("ignores Kubernetes Service-link metadata as a listen port", () =>
    Effect.gen(function*() {
      const config = yield* loadAIGatewayConfig().pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              HOME: "/home/agentos",
              AI_GATEWAY_PORT: "tcp://10.96.0.42:8787",
              AI_GATEWAY_TOKEN: "fleet-secret",
            },
          }),
        ),
      );
      assert.strictEqual(config.port, 8787);
    }));

  it.effect("uses the client token for status without exposing it in output", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      assert.strictEqual(
        yield* runAIGatewayCli(["status"], configuration()).pipe(
          Effect.provide(harness.layer),
        ),
        0,
      );
      assert.deepStrictEqual(yield* Ref.get(harness.statusTokens), [
        "fleet-secret",
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.output), [
        '{"accounts":[],"apiKeyFallback":false}',
      ]);
    }));

  it.effect("prefers the dedicated operator credential for status", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness();
      assert.strictEqual(
        yield* runAIGatewayCli(
          ["status"],
          configuration({ operatorToken: Redacted.make("operator-only") }),
        ).pipe(Effect.provide(harness.layer)),
        0,
      );
      assert.deepStrictEqual(yield* Ref.get(harness.statusTokens), [
        "operator-only",
      ]);
    }));
});
