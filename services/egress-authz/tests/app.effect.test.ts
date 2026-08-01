import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDecisionReferenceGenerator,
  ProviderPolicyDecisionError,
  ProviderPolicyDecisionPoint,
  WorkloadAuthenticationError,
  WorkloadIdentityAuthenticator,
  type ProviderPolicyDecisionRefV1,
  type WorkloadIdentityV1,
} from "@akua-dev/agentos";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Ref,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpRouter } from "effect/unstable/http";

import {
  EgressAuthorizerReadiness,
  makeEgressAuthorizerRequestHandler,
  makeEgressAuthorizerRoutesLayer,
} from "../src/app.ts";

const now = 1_785_586_000_000;
const agentId = "10000000-0000-4000-8000-000000000001";
const assignmentId = "20000000-0000-4000-8000-000000000001";

const identity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId,
  role: "crewmate",
  fleet: "agentos",
  domain: "engineering",
  assignmentId,
  kubernetesNamespace: "agentos-engineering",
  kubernetesPod: "worker-0",
  podUid: "pod-uid-1",
  serviceAccountName: "worker",
  serviceAccountUid: "service-account-uid-1",
};

const decision: ProviderPolicyDecisionRefV1 = {
  schemaVersion: 1,
  correlationId: "corr_44444444444444444444444444444444",
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

function request(path = "/authorize", method = "POST") {
  return new Request(`http://egress-authz.test${path}`, {
    method,
    headers: {
      authorization: "Bearer projected-workload-jwt",
      "x-agentos-original-method": "POST",
      "x-agentos-original-path": "/v1/responses",
      "x-agentos-assignment-id": assignmentId,
    },
  });
}

function services(options?: {
  readonly authenticate?: WorkloadIdentityAuthenticator["Service"]["authenticate"];
  readonly ready?: Effect.Effect<boolean, unknown>;
}) {
  return Layer.mergeAll(
    Layer.succeed(WorkloadIdentityAuthenticator, {
      authenticate: options?.authenticate ?? (() => Effect.succeed(identity)),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(ProviderPolicyDecisionPoint, {
      decide: (input) => Effect.succeed({
        ...decision,
        correlationId: input.correlationId,
      }),
    }),
    Layer.succeed(ProviderDecisionReferenceGenerator, {
      next: Effect.succeed("44444444444444444444444444444444"),
    }),
    Layer.succeed(EgressAuthorizerReadiness, {
      check: options?.ready ?? Effect.succeed(true),
    }),
  );
}

const makeHandler = makeEgressAuthorizerRequestHandler({
  maximumConcurrentRequests: 1,
  requestTimeoutMillis: 100,
  readinessTimeoutMillis: 50,
  maximumHeaderCount: 32,
  maximumHeaderBytes: 8 * 1_024,
  maximumHeaderValueBytes: 4 * 1_024,
  clock: Effect.succeed(now),
});

describe("Effect egress authorization HTTP application", () => {
  it.effect("serves the request core through an Effect Platform HTTP router", () =>
    Effect.acquireUseRelease(
      Effect.succeed(HttpRouter.toWebHandler(
        makeEgressAuthorizerRoutesLayer({
          maximumConcurrentRequests: 1,
          requestTimeoutMillis: 100,
          readinessTimeoutMillis: 50,
          maximumHeaderCount: 32,
          maximumHeaderBytes: 8 * 1_024,
          maximumHeaderValueBytes: 4 * 1_024,
          clock: Effect.succeed(now),
        }).pipe(Layer.provide(services())),
        { disableLogger: true },
      )),
      (web) => Effect.tryPromise(() => web.handler(request("/livez", "GET"))),
      (web) => Effect.promise(web.dispose),
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => assert.strictEqual(response.status, 200))
      ),
    ));

  it.effect("serves finite health state and rejects unsupported routes and methods", () =>
    Effect.gen(function*() {
      const handler = yield* makeHandler;
      assert.strictEqual((yield* handler(request("/livez", "GET"))).status, 200);
      assert.strictEqual((yield* handler(request("/readyz", "GET"))).status, 200);
      assert.strictEqual((yield* handler(request("/unknown", "GET"))).status, 404);
      assert.strictEqual((yield* handler(request("/authorize", "GET"))).status, 405);
    }).pipe(Effect.provide(services())));

  it.effect("fails readiness closed without exposing the dependency failure", () =>
    Effect.gen(function*() {
      const handler = yield* makeHandler;
      const response = yield* handler(request("/readyz", "GET"));
      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
        status: "not_ready",
      });
    }).pipe(
      Effect.provide(services({
        ready: Effect.fail(ProviderPolicyDecisionError.make({
          outcome: "database_unavailable",
          retryable: true,
        })),
      })),
    ));

  it.effect("rejects oversized request metadata before authenticating", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticate: () =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.as(identity),
            ),
        })),
      );
      const oversized = request();
      oversized.headers.set("x-large", "x".repeat(4 * 1_024 + 1));
      const response = yield* handler(oversized);
      assert.strictEqual(response.status, 400);
      assert.strictEqual(yield* Ref.get(calls), 0);
    }));

  it.effect("rejects oversized bodies before authentication and never reflects input", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticate: () =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.as(identity),
            ),
        })),
      );
      const oversized = request();
      oversized.headers.set("content-length", String(256 * 1_024 + 1));
      oversized.headers.set("x-sensitive-marker", "never-reflect-this");
      const response = yield* handler(oversized);
      assert.strictEqual(response.status, 403);
      assert.strictEqual(yield* Ref.get(calls), 0);
      assert.notInclude(
        yield* Effect.tryPromise(() => response.text()),
        "never-reflect-this",
      );
    }));

  it.effect("never reflects malformed bearer material", () =>
    Effect.gen(function*() {
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticate: () => Effect.fail(WorkloadAuthenticationError.make({
            code: "invalid_token",
          })),
        })),
      );
      const malformed = request();
      malformed.headers.set(
        "authorization",
        "Bearer never-reflect-this",
      );
      const response = yield* handler(malformed);
      assert.strictEqual(response.status, 401);
      assert.notInclude(
        yield* Effect.tryPromise(() => response.text()),
        "never-reflect-this",
      );
    }));

  it.effect("fails overload immediately and releases its permit on interruption", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalized = yield* Ref.make(false);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticate: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(identity),
              Effect.ensuring(Ref.set(finalized, true)),
            ),
        })),
      );
      const active = yield* Effect.forkChild(handler(request()), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      const overloaded = yield* handler(request());
      assert.strictEqual(overloaded.status, 503);
      assert.deepStrictEqual(
        yield* Effect.tryPromise(() => overloaded.json()),
        { error: "authorization_overloaded" },
      );
      yield* Fiber.interrupt(active);
      assert.strictEqual(yield* Ref.get(finalized), true);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* handler(request())).status, 200);
    }));

  it.effect("interrupts timed-out authorization work and returns a stable response", () =>
    Effect.gen(function*() {
      const finalized = yield* Ref.make(false);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticate: () =>
            Effect.never.pipe(Effect.ensuring(Ref.set(finalized, true))),
        })),
      );
      const fiber = yield* Effect.forkChild(handler(request()), {
        startImmediately: true,
      });
      yield* TestClock.adjust(101);
      const response = yield* Fiber.join(fiber);
      assert.strictEqual(response.status, 503);
      assert.strictEqual(yield* Ref.get(finalized), true);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
        error: "authorization_unavailable",
      });
    }));
});
