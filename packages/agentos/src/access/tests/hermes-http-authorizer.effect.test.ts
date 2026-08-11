import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  HermesProviderAccessPolicySource,
  HermesProviderAccessPolicyDependencyUnavailable,
  createHermesProviderAuthorization,
} from "../hermes-authorizer.ts";
import {
  ProviderPolicyDecisionPoint,
  type ProviderPolicyDecisionRefV1,
} from "../credential-delivery.ts";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  KubernetesBoundServiceAccountAuthenticator,
  type KubernetesBoundServiceAccountIdentityV1,
  WorkloadAuthenticationError,
  WorkloadIdentityAuthenticator,
  type WorkloadIdentityV1,
} from "../identity.ts";
import {
  createProviderAuthorizationHttpHandler,
  decodeProviderAuthorizationGrantHeaders,
} from "../http-authorizer.ts";
import type { ProviderBudgetEnforcer } from "../provider-budget.ts";

const now = 1_785_586_000_000;
const tokenExpiresAtMillis = now + 600_000;
const limits = {
  requestWindowMillis: 60_000,
  maximumRequests: 20,
  maximumConcurrent: 2,
  tokenWindowMillis: 60_000,
  maximumTokens: 100_000,
  spendWindowMillis: 3_600_000,
  maximumSpendMicros: 2_000_000,
};
const budgets: ProviderBudgetEnforcer["Service"] = {
  validateWorkload: () => Effect.void,
  reserveWorkload: (input) => Effect.succeed({
    schemaVersion: 1,
    decisionRef: input.decisionRef,
    budgetKey: `budget_${"7".repeat(64)}`,
    outcome: "reserved",
    effectiveRateClass: input.rateClass,
    requestWindowEndsAtMillis: input.nowMillis + 60_000,
    tokenWindowEndsAtMillis: input.nowMillis + 60_000,
    spendWindowEndsAtMillis: input.nowMillis + 3_600_000,
    leaseExpiresAtMillis: input.policyExpiresAtMillis,
  }),
  reserve: () => Effect.die("legacy reservation is not expected"),
  settle: () => Effect.die("settlement is not expected"),
  settleProvider: () => Effect.die("provider settlement is not expected"),
};

const boundIdentity: KubernetesBoundServiceAccountIdentityV1 = {
  schemaVersion: 1,
  tokenExpiresAtMillis,
  kubernetesNamespace: "hermes-workers",
  kubernetesPod: "hermes-codex-0",
  podUid: "pod-uid-1",
  serviceAccountName: "hermes-codex",
  serviceAccountUid: "service-account-uid-1",
};

const legacyIdentity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId: "10000000-0000-4000-8000-000000000001",
  role: "crewmate",
  fleet: "agentos",
  domain: "engineering",
  assignmentId: "20000000-0000-4000-8000-000000000001",
  kubernetesNamespace: "agentos-engineering",
  kubernetesPod: "worker-0",
  podUid: "legacy-pod-uid",
  serviceAccountName: "worker",
  serviceAccountUid: "legacy-service-account-uid",
};

function legacyDecision(correlationId: string): ProviderPolicyDecisionRefV1 {
  return {
    schemaVersion: 1,
    correlationId,
    decisionRef: "decision_22222222222222222222222222222222",
    decision: "allow",
    credentialDomain: "openai-responses",
    expiresAtMillis: now + 15_000,
    profile: { profileId: "openai-responses", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  };
}

function policy(
  resourceVersion = "18422",
  expiresAtMillis: number | null = null,
  disabled = false,
) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "agentos-hermes-provider-access-v1",
      namespace: "agentos",
      resourceVersion,
    },
    data: {
      "policy.json": JSON.stringify({
        apiVersion: "agentos.akua.dev/hermes-provider-access/v1",
        revision: 7,
        bindings: [{
          namespace: "hermes-workers",
          serviceAccountName: "hermes-codex",
          hermesProfile: "default",
          providers: [{
            provider: "openai",
            credentialDomains: ["openai-responses"],
            models: ["gpt-5.6-sol"],
            capabilities: ["responses.create", "responses.compact"],
            rateClass: "standard",
            limits,
          }],
          expiresAtMillis,
          disabled,
        }],
      }),
    },
  };
}

function request(model = "gpt-5.6-sol") {
  const body = JSON.stringify({
    model,
    max_output_tokens: 100,
    input: "not inspected for authority",
  });
  return new Request("http://authorizer.test/authorize", {
    method: "POST",
    headers: {
      authorization: "Bearer projected-workload-jwt",
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "x-agentos-original-method": "POST",
      "x-agentos-original-path": "/v1/responses",
      "x-agentos-assignment-id": "20000000-0000-4000-8000-000000000001",
      "x-agentos-profile": "spoofed",
      "x-agentos-model": "gpt-4",
      "x-hermes-task-id": "caller-controlled-audit-only",
    },
    body,
  });
}

function dependencies(
  identityStoreCalls: Ref.Ref<number>,
  currentPolicy: Ref.Ref<unknown>,
  authenticate: KubernetesBoundServiceAccountAuthenticator["Service"]["authenticate"] =
    () => Effect.succeed(boundIdentity),
  current: HermesProviderAccessPolicySource["Service"]["current"] = Ref.get(currentPolicy),
) {
  return Layer.mergeAll(
    Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
      authenticate,
    }),
    Layer.succeed(HermesProviderAccessPolicySource, {
      current,
    }),
    Layer.succeed(WorkloadIdentityAuthenticator, {
      authenticate: () =>
        Ref.update(identityStoreCalls, (value) => value + 1).pipe(
          Effect.andThen(Effect.die("Hermes must not resolve AgentOS identity")),
        ),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(ProviderPolicyDecisionPoint, {
      decide: () => Effect.die("Hermes must not use the AgentOS PDP"),
    }),
  );
}

describe("Hermes Kubernetes workload HTTP authorization", () => {
  it.effect("denies an authenticated Hermes workload after its policy binding is removed", () =>
    Effect.gen(function*() {
      const legacyIdentityCalls = yield* Ref.make(0);
      const legacyPdpCalls = yield* Ref.make(0);
      const emptyPolicy = policy();
      emptyPolicy.data["policy.json"] = JSON.stringify({
        apiVersion: "agentos.akua.dev/hermes-provider-access/v1",
        revision: 8,
        bindings: [],
      });
      const currentPolicy = yield* Ref.make<unknown>(emptyPolicy);
      const layer = Layer.mergeAll(
        Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
          authenticate: () => Effect.succeed(boundIdentity),
        }),
        Layer.succeed(HermesProviderAccessPolicySource, {
          current: Ref.get(currentPolicy),
        }),
        Layer.succeed(WorkloadIdentityAuthenticator, {
          authenticate: () =>
            Ref.update(legacyIdentityCalls, (value) => value + 1).pipe(
              Effect.as(legacyIdentity),
            ),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(ProviderPolicyDecisionPoint, {
          decide: (input) =>
            Ref.update(legacyPdpCalls, (value) => value + 1).pipe(
              Effect.as(legacyDecision(input.correlationId)),
            ),
        }),
      );

      const response = yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("44444444444444444444444444444444"),
          hermes,
          budgets,
        });
        return yield* handler(request());
      }).pipe(Effect.provide(layer));

      assert.strictEqual(response.status, 403);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        error: "forbidden",
      });
      assert.strictEqual(yield* Ref.get(legacyIdentityCalls), 0);
      assert.strictEqual(yield* Ref.get(legacyPdpCalls), 0);
    }));

  it.effect("reviews modern Gateway tokens against the canonical audience without invoking legacy authorization", () =>
    Effect.gen(function*() {
      const hermesAudiences = yield* Ref.make<ReadonlyArray<string>>([]);
      const legacyIdentityCalls = yield* Ref.make(0);
      const legacyPdpCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      const layer = Layer.mergeAll(
        Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
          authenticate: (input) =>
            Ref.update(hermesAudiences, (values) => [...values, input.audience]).pipe(
              Effect.andThen(Effect.fail(WorkloadAuthenticationError.make({
                code: "token_review_rejected",
              }))),
            ),
        }),
        Layer.succeed(HermesProviderAccessPolicySource, {
          current: Ref.get(currentPolicy),
        }),
        Layer.succeed(WorkloadIdentityAuthenticator, {
          authenticate: () =>
            Ref.update(legacyIdentityCalls, (value) => value + 1).pipe(
              Effect.as(legacyIdentity),
            ),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(ProviderPolicyDecisionPoint, {
          decide: (input) =>
            Ref.update(legacyPdpCalls, (value) => value + 1).pipe(
              Effect.as(legacyDecision(input.correlationId)),
            ),
        }),
      );

      const response = yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("44444444444444444444444444444444"),
          hermes,
          budgets,
        });
        const nonHermesRequest = request();
        nonHermesRequest.headers.set("x-agentos-hermes-profile", "default");
        nonHermesRequest.headers.set("x-hermes-task-id", "spoofed-workload");
        return yield* handler(nonHermesRequest);
      }).pipe(Effect.provide(layer));

      assert.strictEqual(response.status, 401);
      assert.deepStrictEqual(yield* Ref.get(hermesAudiences), [
        AGENTOS_EGRESS_TOKEN_AUDIENCE,
      ]);
      assert.strictEqual(yield* Ref.get(legacyIdentityCalls), 0);
      assert.strictEqual(yield* Ref.get(legacyPdpCalls), 0);
    }));

  it.effect("authorizes the exact live policy-bound model without Agent or Assignment lookup", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("44444444444444444444444444444444"),
          hermes,
          budgets,
        });

        const response = yield* handler(request());
        assert.strictEqual(response.status, 200);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
        const grant = yield* decodeProviderAuthorizationGrantHeaders(
          response.headers,
          {
            method: "POST",
            path: "/v1/responses",
            nowMillis: now,
            body: JSON.stringify({
              model: "gpt-5.6-sol",
              max_output_tokens: 100,
              input: "not inspected for authority",
            }),
          },
        );
        assert.deepStrictEqual(grant.identity, {
          kind: "kubernetes_workload",
          namespace: "hermes-workers",
          serviceAccountName: "hermes-codex",
          policyRevision: 7,
          policyResourceVersion: "18422",
          hermesProfile: "default",
        });
        assert.isTrue("model" in grant);
        if ("model" in grant) {
          assert.strictEqual(grant.model, "gpt-5.6-sol");
          assert.deepStrictEqual(grant.limits, limits);
        }
      }).pipe(Effect.provide(dependencies(identityStoreCalls, currentPolicy)));
    }));

  it.effect("never issues a grant beyond the current policy expiry", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy("18422", now + 5_000));
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("44444444444444444444444444444444"),
          hermes,
          budgets,
        });
        const response = yield* handler(request());
        assert.strictEqual(
          response.headers.get("x-agentos-authz-expires-at-millis"),
          String(now + 5_000),
        );
      }).pipe(Effect.provide(dependencies(identityStoreCalls, currentPolicy)));
    }));

  it.effect("denies a forged model even when caller metadata claims the allowed Hermes profile", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("55555555555555555555555555555555"),
          hermes,
          budgets,
        });
        const forged = request("gpt-4.1");
        forged.headers.set("x-agentos-hermes-profile", "default");
        forged.headers.set("x-agentos-policy-revision", "7");
        forged.headers.set("x-agentos-task-id", "trusted-task");
        assert.strictEqual((yield* handler(forged)).status, 403);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(identityStoreCalls, currentPolicy)));
    }));

  it.effect("denies a namespace mismatch for an otherwise policy-targeted Hermes ServiceAccount", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
          hermes,
          budgets,
        });
        assert.strictEqual((yield* handler(request())).status, 403);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(
        identityStoreCalls,
        currentPolicy,
        () => Effect.succeed({ ...boundIdentity, kubernetesNamespace: "forged" }),
      )));
    }));

  it.effect("denies a ServiceAccount mismatch inside the Hermes policy namespace", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
          hermes,
          budgets,
        });
        assert.strictEqual((yield* handler(request())).status, 403);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(
        identityStoreCalls,
        currentPolicy,
        () => Effect.succeed({ ...boundIdentity, serviceAccountName: "forged" }),
      )));
    }));

  it.effect("rereads policy and revokes a previously authorized workload without legacy fallback", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("66666666666666666666666666666666"),
          hermes,
          budgets,
        });
        assert.strictEqual((yield* handler(request())).status, 200);
        yield* Ref.set(currentPolicy, policy("18423", null, true));
        assert.strictEqual((yield* handler(request())).status, 403);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(identityStoreCalls, currentPolicy)));
    }));

  it.effect("fails closed on bound identity rejection without consulting Agent or Assignment identity", () =>
    Effect.gen(function*() {
      const rejectionCodes: ReadonlyArray<WorkloadAuthenticationError["code"]> = [
        "pod_uid_mismatch",
        "service_account_uid_mismatch",
      ];
      for (const code of rejectionCodes) {
        const identityStoreCalls = yield* Ref.make(0);
        const currentPolicy = yield* Ref.make<unknown>(policy());
        yield* Effect.gen(function*() {
          const hermes = yield* createHermesProviderAuthorization();
          const handler = yield* createProviderAuthorizationHttpHandler({
            clock: Effect.succeed(now),
            id: Effect.succeed("77777777777777777777777777777777"),
          hermes,
          budgets,
        });
          assert.strictEqual((yield* handler(request())).status, 401);
          assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
        }).pipe(Effect.provide(dependencies(
          identityStoreCalls,
          currentPolicy,
          () => Effect.fail(WorkloadAuthenticationError.make({ code })),
        )));
      }
    }));

  it.effect("denies a token outside the canonical audience before any policy decision point", () =>
    Effect.gen(function*() {
      const boundAuthenticationCalls = yield* Ref.make(0);
      const legacyIdentityCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      const layer = Layer.mergeAll(
        Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
          authenticate: () =>
            Ref.update(boundAuthenticationCalls, (value) => value + 1).pipe(
              Effect.andThen(Effect.fail(WorkloadAuthenticationError.make({
                code: "wrong_audience",
              }))),
            ),
        }),
        Layer.succeed(HermesProviderAccessPolicySource, {
          current: Ref.get(currentPolicy),
        }),
        Layer.succeed(WorkloadIdentityAuthenticator, {
          authenticate: () =>
            Ref.update(legacyIdentityCalls, (value) => value + 1).pipe(
              Effect.andThen(Effect.fail(WorkloadAuthenticationError.make({
                code: "wrong_audience",
              }))),
            ),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(ProviderPolicyDecisionPoint, {
          decide: () => Effect.die("invalid identity must not reach the PDP"),
        }),
      );
      const response = yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("77777777777777777777777777777777"),
          hermes,
          budgets,
        });
        return yield* handler(request());
      }).pipe(Effect.provide(layer));

      assert.strictEqual(response.status, 401);
      assert.strictEqual(yield* Ref.get(boundAuthenticationCalls), 1);
      assert.strictEqual(yield* Ref.get(legacyIdentityCalls), 0);
    }));

  it.effect("denies malformed policy without falling back to legacy Agent identity", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>({ apiVersion: "v1", kind: "ConfigMap" });
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("88888888888888888888888888888888"),
          hermes,
          budgets,
        });
        assert.strictEqual((yield* handler(request())).status, 403);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(identityStoreCalls, currentPolicy)));
    }));

  it.effect("reports live policy dependency failure as unavailable without legacy fallback", () =>
    Effect.gen(function*() {
      const identityStoreCalls = yield* Ref.make(0);
      const currentPolicy = yield* Ref.make<unknown>(policy());
      yield* Effect.gen(function*() {
        const hermes = yield* createHermesProviderAuthorization();
        const handler = yield* createProviderAuthorizationHttpHandler({
          clock: Effect.succeed(now),
          id: Effect.succeed("99999999999999999999999999999999"),
          hermes,
          budgets,
        });
        assert.strictEqual((yield* handler(request())).status, 503);
        assert.strictEqual(yield* Ref.get(identityStoreCalls), 0);
      }).pipe(Effect.provide(dependencies(
        identityStoreCalls,
        currentPolicy,
        undefined,
        Effect.fail(HermesProviderAccessPolicyDependencyUnavailable.make({
          operation: "get_policy",
        })),
      )));
    }));
});
