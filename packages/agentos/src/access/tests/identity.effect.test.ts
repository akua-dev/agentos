import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Ref, Tracer } from "effect";
import { TestClock } from "effect/testing";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_IDENTITY_POSITIVE_CACHE_TTL_MILLIS,
  AgentOSWorkloadIdentityStore,
  KubernetesBoundServiceAccountAuthenticator,
  KubernetesTokenReviewer,
  KubernetesWorkloadIdentityLookup,
  WorkloadAuthenticationError,
  WorkloadAuthorizationError,
  WorkloadIdentityAuthenticator,
  WorkloadIdentityDependencyUnavailable,
  WorkloadIdentityResolutionError,
  type AgentOSWorkloadAgentV1,
  type AgentOSWorkloadAssignmentV1,
  type KubernetesPodIdentityV1,
  type KubernetesReviewedIdentityV1,
  type KubernetesServiceAccountIdentityV1,
  type WorkloadIdentityAuthenticationRequest,
} from "../identity.ts";

const Now = 1_785_556_800_000;
const AgentId = "11111111-1111-4111-8111-111111111111";
const OtherAgentId = "22222222-2222-4222-8222-222222222222";
const AssignmentId = "33333333-3333-4333-8333-333333333333";
const PodUid = "44444444-4444-4444-8444-444444444444";
const ServiceAccountUid = "55555555-5555-4555-8555-555555555555";
const Namespace = "agentos-domain-platform";
const PodName = "agentos-platform-mate-0";
const ServiceAccountName = "agentos-platform-mate";

function jwt(expirationMillis: number, nonce = "fixture") {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: Math.floor(expirationMillis / 1_000),
    nonce,
  })}.test-signature`;
}

const reviewedIdentity: KubernetesReviewedIdentityV1 = {
  authenticated: true,
  audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
  username:
    `system:serviceaccount:${Namespace}:${ServiceAccountName}`,
  serviceAccountUid: ServiceAccountUid,
  podNames: [PodName],
  podUids: [PodUid],
};

const pod: KubernetesPodIdentityV1 = {
  namespace: Namespace,
  name: PodName,
  uid: PodUid,
  serviceAccountName: ServiceAccountName,
  phase: "Running",
  deletionTimestampMillis: null,
};

const serviceAccount: KubernetesServiceAccountIdentityV1 = {
  namespace: Namespace,
  name: ServiceAccountName,
  uid: ServiceAccountUid,
  deletionTimestampMillis: null,
};

const agent: AgentOSWorkloadAgentV1 = {
  agentId: AgentId,
  role: "second_mate",
  fleet: "agentos",
  domain: "platform",
  kubernetesNamespace: Namespace,
  kubernetesPod: PodName,
  lifecycleStatus: "active",
  retiredAtMillis: null,
};

const assignment: AgentOSWorkloadAssignmentV1 = {
  assignmentId: AssignmentId,
  agentId: AgentId,
  status: "active",
  endedAtMillis: null,
};

interface FixtureOverrides {
  readonly review?: KubernetesTokenReviewer["Service"]["review"];
  readonly getPod?: KubernetesWorkloadIdentityLookup["Service"]["getPod"];
  readonly getServiceAccount?: KubernetesWorkloadIdentityLookup["Service"]["getServiceAccount"];
  readonly findAgentsByWorkload?: AgentOSWorkloadIdentityStore["Service"]["findAgentsByWorkload"];
  readonly findAssignmentsByAgent?: AgentOSWorkloadIdentityStore["Service"]["findAssignmentsByAgent"];
}

function fixtureLayer(overrides: FixtureOverrides = {}) {
  return Layer.mergeAll(
    Layer.succeed(KubernetesTokenReviewer)({
      review: overrides.review ?? (() => Effect.succeed(reviewedIdentity)),
    }),
    Layer.succeed(KubernetesWorkloadIdentityLookup)({
      getPod: overrides.getPod ?? (() => Effect.succeed(pod)),
      getServiceAccount: overrides.getServiceAccount ??
        (() => Effect.succeed(serviceAccount)),
    }),
    Layer.succeed(AgentOSWorkloadIdentityStore)({
      findAgentsByWorkload: overrides.findAgentsByWorkload ??
        (() => Effect.succeed([agent])),
      findAssignmentsByAgent: overrides.findAssignmentsByAgent ??
        (() => Effect.succeed([assignment])),
    }),
  );
}

function withIdentityServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: FixtureOverrides = {},
) {
  return effect.pipe(
    Effect.provide(WorkloadIdentityAuthenticator.layer),
    Effect.provide(fixtureLayer(overrides)),
  );
}

function authenticate(
  bearerToken = jwt(Now + 600_000),
  assignmentRequirement: "not_required" | "required" = "not_required",
) {
  return Effect.gen(function*() {
    const authenticator = yield* WorkloadIdentityAuthenticator;
    return yield* authenticator.authenticate({
      bearerToken,
      assignmentRequirement,
    });
  });
}

describe("Pod-bound workload identity", () => {
  it.effect("reuses the exact TokenReview and live Kubernetes binding without resolving an Agent", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const bound = yield* KubernetesBoundServiceAccountAuthenticator;
      assert.deepStrictEqual(yield* bound.authenticate({
        bearerToken: jwt(Now + 600_000),
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
      }), {
        schemaVersion: 1,
        tokenExpiresAtMillis: Now + 600_000,
        kubernetesNamespace: Namespace,
        kubernetesPod: PodName,
        podUid: PodUid,
        serviceAccountName: ServiceAccountName,
        serviceAccountUid: ServiceAccountUid,
      });
    }).pipe(
      Effect.provide(KubernetesBoundServiceAccountAuthenticator.layer),
      Effect.provide(fixtureLayer()),
    ));

  it.effect("derives one exact live Mate and active Assignment", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const identity = yield* withIdentityServices(
        authenticate(undefined, "required"),
      );
      assert.deepStrictEqual(identity, {
        schemaVersion: 1,
        agentId: AgentId,
        role: "second_mate",
        fleet: "agentos",
        domain: "platform",
        assignmentId: AssignmentId,
        kubernetesNamespace: Namespace,
        kubernetesPod: PodName,
        podUid: PodUid,
        serviceAccountName: ServiceAccountName,
        serviceAccountUid: ServiceAccountUid,
      });
    }));

  it.effect("requires the dedicated audience and exact live bound UIDs", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const cases: ReadonlyArray<{
        readonly expectedCode: string;
        readonly overrides: FixtureOverrides;
      }> = [
        {
          expectedCode: "wrong_audience",
          overrides: {
            review: () =>
              Effect.succeed({ ...reviewedIdentity, audiences: ["kubernetes"] }),
          },
        },
        {
          expectedCode: "pod_uid_mismatch",
          overrides: {
            getPod: () =>
              Effect.succeed({ ...pod, uid: OtherAgentId }),
          },
        },
        {
          expectedCode: "service_account_uid_mismatch",
          overrides: {
            getServiceAccount: () =>
              Effect.succeed({ ...serviceAccount, uid: OtherAgentId }),
          },
        },
        {
          expectedCode: "pod_deleting",
          overrides: {
            getPod: () =>
              Effect.succeed({ ...pod, deletionTimestampMillis: Now }),
          },
        },
        {
          expectedCode: "pod_not_found",
          overrides: {
            getPod: () => Effect.succeed(null),
          },
        },
        {
          expectedCode: "service_account_deleting",
          overrides: {
            getServiceAccount: () =>
              Effect.succeed({
                ...serviceAccount,
                deletionTimestampMillis: Now,
              }),
          },
        },
        {
          expectedCode: "service_account_not_found",
          overrides: {
            getServiceAccount: () => Effect.succeed(null),
          },
        },
      ];

      yield* Effect.forEach(cases, ({ expectedCode, overrides }) =>
        withIdentityServices(authenticate(), overrides).pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, WorkloadAuthenticationError);
            assert.strictEqual(error.code, expectedCode);
          }),
        ),
      );
    }));

  it.effect("does not let a second Pod reuse a shared ServiceAccount identity", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const otherPod = {
        ...pod,
        name: "agentos-platform-mate-shadow-0",
        uid: OtherAgentId,
      } satisfies KubernetesPodIdentityV1;
      const error = yield* withIdentityServices(authenticate(), {
        review: () =>
          Effect.succeed({
            ...reviewedIdentity,
            podNames: [otherPod.name],
            podUids: [otherPod.uid],
          }),
        getPod: () => Effect.succeed(otherPod),
        findAgentsByWorkload: () => Effect.succeed([]),
      }).pipe(Effect.flip);
      assert.instanceOf(error, WorkloadIdentityResolutionError);
      assert.strictEqual(error.code, "agent_not_found");
    }));

  it.effect("fails closed for inactive or ambiguous Agent and Assignment state", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const inactiveAgent = yield* withIdentityServices(authenticate(), {
        findAgentsByWorkload: () =>
          Effect.succeed([{ ...agent, lifecycleStatus: "provisioning" }]),
      }).pipe(Effect.flip);
      assert.instanceOf(inactiveAgent, WorkloadIdentityResolutionError);
      assert.strictEqual(inactiveAgent.code, "agent_inactive");

      const ambiguousAgent = yield* withIdentityServices(authenticate(), {
        findAgentsByWorkload: () => Effect.succeed([agent, agent]),
      }).pipe(Effect.flip);
      assert.instanceOf(ambiguousAgent, WorkloadIdentityResolutionError);
      assert.strictEqual(ambiguousAgent.code, "agent_ambiguous");

      const inactiveAssignment = yield* withIdentityServices(
        authenticate(undefined, "required"),
        {
          findAssignmentsByAgent: () =>
            Effect.succeed([{ ...assignment, endedAtMillis: Now }]),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(inactiveAssignment, WorkloadIdentityResolutionError);
      assert.strictEqual(inactiveAssignment.code, "assignment_inactive");

      const wrongOwner = yield* withIdentityServices(
        authenticate(undefined, "required"),
        {
          findAssignmentsByAgent: () =>
            Effect.succeed([{ ...assignment, agentId: OtherAgentId }]),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(wrongOwner, WorkloadAuthorizationError);
      assert.strictEqual(wrongOwner.code, "assignment_owner_mismatch");
    }));

  it.effect("never turns TokenReview or identity-store unavailability into identity", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const tokenReviewUnavailable = yield* withIdentityServices(authenticate(), {
        review: () =>
          WorkloadIdentityDependencyUnavailable.make({
            dependency: "token_review",
            operation: "review",
          }),
      }).pipe(Effect.flip);
      assert.instanceOf(
        tokenReviewUnavailable,
        WorkloadIdentityDependencyUnavailable,
      );
      assert.strictEqual(tokenReviewUnavailable.dependency, "token_review");

      const storeUnavailable = yield* withIdentityServices(authenticate(), {
        findAgentsByWorkload: () =>
          WorkloadIdentityDependencyUnavailable.make({
            dependency: "identity_store",
            operation: "find_agent",
          }),
      }).pipe(Effect.flip);
      assert.instanceOf(storeUnavailable, WorkloadIdentityDependencyUnavailable);
      assert.strictEqual(storeUnavailable.dependency, "identity_store");
    }));

  it.effect("rejects an invalid bearer envelope before TokenReview", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const reviewCalls = yield* Ref.make(0);
      const invalid = yield* withIdentityServices(authenticate(""), {
        review: () =>
          Ref.update(reviewCalls, (count) => count + 1).pipe(
            Effect.as(reviewedIdentity),
          ),
      }).pipe(Effect.flip);
      assert.instanceOf(invalid, WorkloadAuthenticationError);
      assert.strictEqual(invalid.code, "invalid_token");
      assert.strictEqual(yield* Ref.get(reviewCalls), 0);
    }));

  it.effect("caps positive caching, honors token expiry, and invalidates by identity", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const calls = yield* Ref.make(0);
      const token = jwt(Now + 20_000, "short-lived");
      const program = Effect.gen(function*() {
        const authenticator = yield* WorkloadIdentityAuthenticator;
        const request: WorkloadIdentityAuthenticationRequest = {
          bearerToken: token,
          assignmentRequirement: "required",
        };
        yield* authenticator.authenticate(request);
        yield* authenticator.authenticate(request);
        assert.strictEqual(yield* Ref.get(calls), 1);

        yield* TestClock.adjust(AGENTOS_IDENTITY_POSITIVE_CACHE_TTL_MILLIS + 1);
        yield* authenticator.authenticate(request);
        assert.strictEqual(yield* Ref.get(calls), 2);

        yield* authenticator.invalidate({ kind: "pod", podUid: PodUid });
        yield* authenticator.authenticate(request);
        assert.strictEqual(yield* Ref.get(calls), 3);

        yield* TestClock.adjust(5_000);
        const expired = yield* authenticator.authenticate(request).pipe(
          Effect.flip,
        );
        assert.instanceOf(expired, WorkloadAuthenticationError);
        assert.strictEqual(expired.code, "token_expired");
        assert.strictEqual(yield* Ref.get(calls), 4);
      });

      yield* withIdentityServices(program, {
        review: () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(reviewedIdentity),
          ),
      });
    }));

  it.effect("keeps bearer material out of typed failures and remains interruptible", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const protectedLiveValue = jwt(
        Now + 600_000,
        "protected-live-token-value",
      );
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* withIdentityServices(authenticate(protectedLiveValue)).pipe(
        Effect.withTracer(tracer),
      );
      const traceData = JSON.stringify(
        spans.map((span) => ({
          attributes: Object.fromEntries(span.attributes),
          events: span.events,
          name: span.name,
        })),
      );
      assert.notInclude(traceData, protectedLiveValue);
      assert.notInclude(traceData, "protected-live-token-value");

      const protectedValue = jwt(Now - 1_000, "protected-token-value");
      const expired = yield* withIdentityServices(
        authenticate(protectedValue),
      ).pipe(Effect.flip);
      assert.instanceOf(expired, WorkloadAuthenticationError);
      assert.notInclude(JSON.stringify(expired), protectedValue);
      assert.notInclude(JSON.stringify(expired), "protected-token-value");

      const blocked = withIdentityServices(authenticate(), {
        review: () => Effect.never,
      });
      const fiber = yield* Effect.forkChild(blocked);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(
        Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason),
      );
    }));
});
