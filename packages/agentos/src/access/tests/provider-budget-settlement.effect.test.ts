import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  KubernetesBoundServiceAccountAuthenticator,
  WorkloadAuthenticationError,
  WorkloadIdentityDependencyUnavailable,
  type KubernetesBoundServiceAccountIdentityV1,
} from "../identity.ts";
import {
  AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_AUDIENCE,
  ProviderBudgetSettlementCallerAuthenticator,
  ProviderBudgetSettlementCallerAuthenticationError,
  providerBudgetSettlementCallersV1,
} from "../provider-budget-settlement.ts";

const githubIdentity: KubernetesBoundServiceAccountIdentityV1 = {
  schemaVersion: 1,
  tokenExpiresAtMillis: 1_785_586_600_000,
  kubernetesNamespace: "agentos",
  kubernetesPod: "github-broker-abcde",
  podUid: "pod-github",
  serviceAccountName: "github-broker",
  serviceAccountUid: "service-account-github",
};

function liveLayer(
  authenticate: KubernetesBoundServiceAccountAuthenticator["Service"]["authenticate"],
) {
  return ProviderBudgetSettlementCallerAuthenticator.layer.pipe(
    Layer.provide(Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
      authenticate,
    })),
  );
}

describe("provider budget settlement caller identity", () => {
  it.effect("publishes only the reviewed provider ServiceAccounts", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(providerBudgetSettlementCallersV1, [
        {
          provider: "github",
          credentialDomain: "github",
          kubernetesNamespace: "agentos",
          serviceAccountName: "github-broker",
        },
        {
          provider: "openai",
          credentialDomain: "openai-responses",
          kubernetesNamespace: "agentos",
          serviceAccountName: "ai-gateway",
        },
      ]);
    }));

  it.effect("derives GitHub authority from the live bound ServiceAccount", () => {
    const seen: Array<{ readonly audience: string }> = [];
    return Effect.gen(function*() {
      const caller = yield* ProviderBudgetSettlementCallerAuthenticator;
      assert.deepStrictEqual(yield* caller.authenticate("projected-token"), {
        schemaVersion: 1,
        provider: "github",
        credentialDomain: "github",
        kubernetesNamespace: "agentos",
        kubernetesPod: githubIdentity.kubernetesPod,
        podUid: githubIdentity.podUid,
        serviceAccountName: "github-broker",
        serviceAccountUid: githubIdentity.serviceAccountUid,
      });
      assert.deepStrictEqual(seen, [{
        audience: AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_AUDIENCE,
      }]);
    }).pipe(Effect.provide(liveLayer((request) => {
      seen.push({ audience: request.audience });
      return Effect.succeed(githubIdentity);
    })));
  });

  it.effect("rejects unregistered callers and redacts identity dependency failures", () =>
    Effect.gen(function*() {
      const unregistered = yield* ProviderBudgetSettlementCallerAuthenticator.pipe(
        Effect.flatMap((caller) => caller.authenticate("protected-token")),
        Effect.provide(liveLayer(() => Effect.succeed({
          ...githubIdentity,
          serviceAccountName: "agentgateway",
        }))),
        Effect.flip,
      );
      assert.instanceOf(
        unregistered,
        ProviderBudgetSettlementCallerAuthenticationError,
      );
      assert.strictEqual(unregistered.outcome, "forbidden");

      const invalid = yield* ProviderBudgetSettlementCallerAuthenticator.pipe(
        Effect.flatMap((caller) => caller.authenticate("protected-token")),
        Effect.provide(liveLayer(() =>
          Effect.fail(WorkloadAuthenticationError.make({
            code: "invalid_token",
          }))
        )),
        Effect.flip,
      );
      assert.strictEqual(invalid.outcome, "unauthorized");

      const unavailable = yield* ProviderBudgetSettlementCallerAuthenticator.pipe(
        Effect.flatMap((caller) => caller.authenticate("protected-token")),
        Effect.provide(liveLayer(() =>
          Effect.fail(WorkloadIdentityDependencyUnavailable.make({
            dependency: "token_review",
            operation: "review",
          }))
        )),
        Effect.flip,
      );
      assert.strictEqual(unavailable.outcome, "dependency_unavailable");
      assert.notInclude(JSON.stringify([invalid, unavailable]), "protected-token");
    }));
});
