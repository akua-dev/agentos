import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  HermesProviderAccessPolicySource,
  HermesProviderAccessPolicyDependencyUnavailable,
  createHermesProviderAuthorization,
} from "../hermes-authorizer.ts";
import {
  ProviderPolicyDecisionPoint,
} from "../credential-delivery.ts";
import {
  KubernetesBoundServiceAccountAuthenticator,
  type KubernetesBoundServiceAccountIdentityV1,
  WorkloadAuthenticationError,
  WorkloadIdentityAuthenticator,
} from "../identity.ts";
import {
  createProviderAuthorizationHttpHandler,
  decodeProviderAuthorizationGrantHeaders,
} from "../http-authorizer.ts";

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

const boundIdentity: KubernetesBoundServiceAccountIdentityV1 = {
  schemaVersion: 1,
  tokenExpiresAtMillis,
  kubernetesNamespace: "hermes-workers",
  kubernetesPod: "hermes-codex-0",
  podUid: "pod-uid-1",
  serviceAccountName: "hermes-codex",
  serviceAccountUid: "service-account-uid-1",
};

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
  const body = JSON.stringify({ model, input: "not inspected for authority" });
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
            body: JSON.stringify({ model: "gpt-5.6-sol" }),
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
        "wrong_audience",
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
