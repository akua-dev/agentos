import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeHermesProviderAccessConfigMapV1,
  HermesProviderAccessPolicyError,
  loadHermesProviderAccessConfigMapV1,
} from "../kubernetes-workload-policy.ts";

const validPolicy = {
  apiVersion: "agentos.akua.dev/hermes-provider-access/v1",
  revision: 7,
  bindings: [
    {
      namespace: "hermes-akua",
      serviceAccountName: "hermes-codex-worker",
      hermesProfile: "fleet-codex",
      providers: [
        {
          provider: "openai",
          credentialDomains: ["fleet-codex"],
          models: ["gpt-5.6-sol"],
          capabilities: ["responses.create"],
          rateClass: "standard",
          limits: {
            requestWindowMillis: 60_000,
            maximumRequests: 60,
            maximumConcurrent: 4,
            tokenWindowMillis: 60_000,
            maximumTokens: 1_000_000,
            spendWindowMillis: 3_600_000,
            maximumSpendMicros: 10_000_000,
          },
        },
      ],
      expiresAtMillis: null,
      disabled: false,
    },
  ],
};

function configMap(policy: unknown = validPolicy) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "agentos-hermes-provider-access-v1",
      namespace: "agentos",
      resourceVersion: "18422",
    },
    data: { "policy.json": JSON.stringify(policy) },
  };
}

describe("Hermes Kubernetes workload provider policy", () => {
  it.effect("decodes a versioned ConfigMap into exact workload principals", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeHermesProviderAccessConfigMapV1(configMap());

      assert.strictEqual(decoded.resourceVersion, "18422");
      assert.strictEqual(decoded.revision, 7);
      assert.deepStrictEqual(decoded.bindings[0]?.principal, {
        kind: "kubernetes_workload",
        namespace: "hermes-akua",
        serviceAccountName: "hermes-codex-worker",
        policyRevision: 7,
        hermesProfile: "fleet-codex",
      });
      assert.strictEqual(
        decoded.bindings[0]?.providers[0]?.models[0],
        "gpt-5.6-sol",
      );
    }));

  it.effect("rejects duplicate namespace and ServiceAccount bindings", () =>
    Effect.gen(function*() {
      const duplicate = {
        ...validPolicy,
        bindings: [validPolicy.bindings[0], validPolicy.bindings[0]],
      };
      const result = yield* Effect.exit(
        decodeHermesProviderAccessConfigMapV1(configMap(duplicate)),
      );

      assert.strictEqual(result._tag, "Failure");
    }));

  it.effect("rejects ambiguous or unrealizable provider allowlists", () =>
    Effect.gen(function*() {
      const binding = validPolicy.bindings[0]!;
      const provider = binding.providers[0]!;
      const invalidProviders: ReadonlyArray<unknown> = [
        { ...provider, credentialDomains: ["fleet-codex", "fleet-codex"] },
        { ...provider, models: ["gpt-5.6-sol", "gpt-5.6-sol"] },
        { ...provider, capabilities: ["responses.create", "responses.create"] },
        { ...provider, limits: { ...provider.limits, maximumConcurrent: 0 } },
        {
          ...provider,
          limits: {
            ...provider.limits,
            maximumTokens: Number.MAX_SAFE_INTEGER + 1,
          },
        },
        {
          ...provider,
          rateClass: "disabled",
          limits: {
            ...provider.limits,
            maximumRequests: 0,
            maximumConcurrent: 0,
            maximumTokens: 0,
            maximumSpendMicros: 1,
          },
        },
      ];

      yield* Effect.forEach(invalidProviders, (invalidProvider) =>
        Effect.gen(function*() {
          const result = yield* Effect.exit(
            decodeHermesProviderAccessConfigMapV1(configMap({
              ...validPolicy,
              bindings: [{ ...binding, providers: [invalidProvider] }],
            })),
          );
          assert.strictEqual(result._tag, "Failure");
        }),
      );
    }));

  it.effect("loads only an exact active namespace and ServiceAccount binding", () =>
    Effect.gen(function*() {
      const exact = yield* loadHermesProviderAccessConfigMapV1(configMap(), {
        namespace: "hermes-akua",
        serviceAccountName: "hermes-codex-worker",
        atMillis: 1_786_435_200_000,
      });
      assert.strictEqual(exact.principal.hermesProfile, "fleet-codex");

      const binding = validPolicy.bindings[0]!;
      const failures = yield* Effect.all([
        loadHermesProviderAccessConfigMapV1(configMap(), {
          namespace: "wrong-namespace",
          serviceAccountName: "hermes-codex-worker",
          atMillis: 1_786_435_200_000,
        }).pipe(Effect.flip),
        loadHermesProviderAccessConfigMapV1(configMap({
          ...validPolicy,
          bindings: [{ ...binding, disabled: true }],
        }), {
          namespace: "hermes-akua",
          serviceAccountName: "hermes-codex-worker",
          atMillis: 1_786_435_200_000,
        }).pipe(Effect.flip),
        loadHermesProviderAccessConfigMapV1(configMap({
          ...validPolicy,
          bindings: [{ ...binding, expiresAtMillis: 1_786_435_199_999 }],
        }), {
          namespace: "hermes-akua",
          serviceAccountName: "hermes-codex-worker",
          atMillis: 1_786_435_200_000,
        }).pipe(Effect.flip),
      ]);

      assert.deepStrictEqual(
        failures.map(({ code }) => code),
        ["binding_not_found", "binding_disabled", "binding_expired"],
      );
    }));

  it.effect("maps malformed or authority-bearing ConfigMaps to a safe closed failure", () =>
    Effect.gen(function*() {
      const binding = validPolicy.bindings[0]!;
      const invalidInputs: ReadonlyArray<unknown> = [
        { ...configMap(), taskId: "t_untrusted" },
        {
          ...configMap(),
          metadata: { ...configMap().metadata, namespace: "attacker" },
        },
        configMap({
          ...validPolicy,
          bindings: [{ ...binding, taskId: "t_untrusted" }],
        }),
        {
          ...configMap(),
          data: { "policy.json": "{" },
        },
      ];

      yield* Effect.forEach(invalidInputs, (input) =>
        decodeHermesProviderAccessConfigMapV1(input).pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, HermesProviderAccessPolicyError);
            assert.strictEqual(error.code, "invalid_config_map");
          }),
        ),
      );
    }));
});
