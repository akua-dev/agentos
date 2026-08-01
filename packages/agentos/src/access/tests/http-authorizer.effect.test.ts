import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  ProviderPolicyDecisionPoint,
  type ProviderPolicyDecisionRequestV1,
} from "../credential-delivery.ts";
import {
  WorkloadIdentityAuthenticator,
  type WorkloadIdentityAuthenticationRequest,
} from "../identity.ts";
import {
  createProviderAuthorizationHttpHandler,
  decodeProviderAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
} from "../http-authorizer.ts";

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";
const now = 1_785_586_000_000;

const identity = {
  schemaVersion: 1,
  agentId: AgentId,
  role: "crewmate",
  fleet: "agentos",
  domain: "engineering",
  assignmentId: AssignmentId,
  kubernetesNamespace: "agentos-engineering",
  kubernetesPod: "worker-0",
  podUid: "pod-uid-1",
  serviceAccountName: "worker",
  serviceAccountUid: "service-account-uid-1",
} as const;

function allowedDecision(expiresAtMillis = now + 15_000) {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    decision: "allow",
    credentialDomain: "openai-responses",
    expiresAtMillis,
    profile: { profileId: "openai-responses", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  } as const;
}

function services(input?: {
  readonly authenticate?: (
    request: WorkloadIdentityAuthenticationRequest,
  ) => Effect.Effect<typeof identity, never>;
  readonly decide?: (
    request: ProviderPolicyDecisionRequestV1,
  ) => Effect.Effect<any, any>;
}) {
  return Layer.merge(
    Layer.succeed(WorkloadIdentityAuthenticator, {
      authenticate: input?.authenticate ?? (() => Effect.succeed(identity)),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(ProviderPolicyDecisionPoint, {
      decide: input?.decide ?? (() =>
        Effect.succeed(allowedDecision())),
    }),
  );
}

function request(path = "/v1/responses") {
  return new Request("http://authorizer.test/authorize", {
    method: "POST",
    headers: {
      authorization: "Bearer projected-workload-jwt",
      "x-agentos-original-method": "POST",
      "x-agentos-original-path": path,
      "x-agentos-assignment-id": AssignmentId,
    },
  });
}

describe("AgentGateway HTTP authorization contract", () => {
  it.effect("authenticates the live Assignment and returns a bounded canonical grant", () => {
    const authenticationRequests: WorkloadIdentityAuthenticationRequest[] = [];
    const decisions: ProviderPolicyDecisionRequestV1[] = [];
    return Effect.gen(function*() {
      const handler = yield* createProviderAuthorizationHttpHandler({
        clock: () => now,
        id: () => "44444444444444444444444444444444",
      });
      const response = yield* Effect.promise(() => handler(request()));
      assert.strictEqual(response.status, 200);

      const grant = yield* decodeProviderAuthorizationGrantHeaders(
        response.headers,
        { method: "POST", path: "/v1/responses", nowMillis: now },
      );
      assert.deepStrictEqual(grant, {
        schemaVersion: 1,
        correlationId: "corr_44444444444444444444444444444444",
        decisionRef: "decision_22222222222222222222222222222222",
        expiresAtMillis: now + 15_000,
        credentialDomain: "openai-responses",
        identity: {
          agentId: AgentId,
          role: "crewmate",
          fleet: "agentos",
          domain: "engineering",
          assignmentId: AssignmentId,
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
      } satisfies ProviderAuthorizationGrantV1);
      assert.deepStrictEqual(authenticationRequests, [
        {
          bearerToken: "projected-workload-jwt",
          assignmentRequirement: "required",
        },
      ]);
      assert.deepStrictEqual(decisions, [
        {
          schemaVersion: 1,
          correlationId: "corr_44444444444444444444444444444444",
          credentialDomain: "openai-responses",
          provider: "openai",
          capability: "openai.responses.create",
          resource: {
            kind: "provider_service",
            provider: "openai",
            service: "responses",
          },
          subject: {
            kind: "assignment",
            fleet: "agentos",
            domain: "engineering",
            assignmentId: AssignmentId,
          },
        },
      ]);
    }).pipe(
      Effect.provide(services({
        authenticate: (value) => {
          authenticationRequests.push(value);
          return Effect.succeed(identity);
        },
        decide: (value) => {
          decisions.push(value);
          return Effect.succeed(allowedDecision());
        },
      })),
    );
  });

  it.effect("maps compact requests to the distinct compact capability", () => {
    let observed: ProviderPolicyDecisionRequestV1 | undefined;
    return Effect.gen(function*() {
      const handler = yield* createProviderAuthorizationHttpHandler({
        clock: () => now,
        id: () => "44444444444444444444444444444444",
      });
      const response = yield* Effect.promise(() =>
        handler(request("/v1/responses/compact"))
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(observed?.capability, "openai.responses.compact");
      const grant = yield* decodeProviderAuthorizationGrantHeaders(
        response.headers,
        {
          method: "POST",
          path: "/v1/responses/compact",
          nowMillis: now,
        },
      );
      assert.strictEqual(grant.capability, "openai.responses.compact");
    }).pipe(
      Effect.provide(services({
        decide: (value) => {
          observed = value;
          return Effect.succeed(allowedDecision());
        },
      })),
    );
  });

  it.effect("caps downstream grants independently of a longer policy decision", () =>
    Effect.gen(function*() {
      const handler = yield* createProviderAuthorizationHttpHandler({
        clock: () => now,
        id: () => "44444444444444444444444444444444",
      });
      const response = yield* Effect.promise(() => handler(request()));
      const grant = yield* decodeProviderAuthorizationGrantHeaders(
        response.headers,
        { method: "POST", path: "/v1/responses", nowMillis: now },
      );
      assert.strictEqual(grant.expiresAtMillis, now + 15_000);
    }).pipe(
      Effect.provide(services({
        decide: () => Effect.succeed(allowedDecision(now + 300_000)),
      })),
    ));

  it.effect("rejects missing identity, Assignment mismatch, unsupported routes, and stale grants", () =>
    Effect.gen(function*() {
      const handler = yield* createProviderAuthorizationHttpHandler({
        clock: () => now,
        id: () => "44444444444444444444444444444444",
      });
      const missingBearer = request();
      missingBearer.headers.delete("authorization");
      assert.strictEqual(
        (yield* Effect.promise(() => handler(missingBearer))).status,
        401,
      );

      const mismatch = request();
      mismatch.headers.set(
        "x-agentos-assignment-id",
        "20000000-0000-4000-8000-000000000002",
      );
      assert.strictEqual(
        (yield* Effect.promise(() => handler(mismatch))).status,
        403,
      );
      assert.strictEqual(
        (yield* Effect.promise(() => handler(request("/unknown")))).status,
        403,
      );

      const response = yield* Effect.promise(() => handler(request()));
      const failure = yield* decodeProviderAuthorizationGrantHeaders(
        response.headers,
        { method: "POST", path: "/v1/responses", nowMillis: now + 15_000 },
      ).pipe(Effect.flip);
      assert.strictEqual(failure.code, "grant_expired");
    }).pipe(Effect.provide(services())));

  it.effect("reports policy-decision dependency failures as unavailable", () =>
    Effect.gen(function*() {
      const handler = yield* createProviderAuthorizationHttpHandler({
        clock: () => now,
        id: () => "44444444444444444444444444444444",
      });
      const response = yield* Effect.promise(() => handler(request()));
      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        error: "authorization_unavailable",
      });
    }).pipe(
      Effect.provide(services({
        decide: (value) => Effect.fail({
          schemaVersion: 1,
          provider: value.provider,
          credentialDomain: value.credentialDomain,
          outcome: "credential_unavailable",
          retryable: true,
          correlationId: value.correlationId,
        }),
      })),
    ));
});
