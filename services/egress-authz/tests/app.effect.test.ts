import { assert, describe, it } from "@effect/vitest";
import {
  ProviderBudgetEnforcementError,
  ProviderBudgetEnforcer,
  ProviderBudgetSettlementCallerAuthenticator,
  ProviderBudgetSettlementCallerAuthenticationError,
  ProviderDecisionReferenceGenerator,
  ProviderPolicyDecisionError,
  ProviderPolicyDecisionPoint,
  WorkloadAuthenticationError,
  WorkloadIdentityAuthenticator,
  type ProviderPolicyDecisionRefV1,
  type ProviderBudgetSettlementReportV1,
  type ProviderBudgetSettlementCallerV1,
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

const settlementCaller: ProviderBudgetSettlementCallerV1 = {
  schemaVersion: 1,
  provider: "github",
  credentialDomain: "github",
  kubernetesNamespace: "agentos",
  kubernetesPod: "github-broker-0",
  podUid: "github-broker-pod-uid",
  serviceAccountName: "github-broker",
  serviceAccountUid: "github-broker-service-account-uid",
};

const settlementBody: ProviderBudgetSettlementReportV1 = {
  schemaVersion: 1,
  decisionRef: "decision_22222222222222222222222222222222",
  forwardOutcome: "completed",
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  spendMicros: 0,
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

function settlementRequest(
  body: unknown = settlementBody,
  authorization = "Bearer projected-provider-jwt",
) {
  const encoded = JSON.stringify(body);
  return new Request("http://egress-authz.test/settle", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(encoded).byteLength),
    },
    body: encoded,
  });
}

function services(options?: {
  readonly authenticate?: WorkloadIdentityAuthenticator["Service"]["authenticate"];
  readonly authenticateSettlement?: ProviderBudgetSettlementCallerAuthenticator["Service"]["authenticate"];
  readonly settleProvider?: ProviderBudgetEnforcer["Service"]["settleProvider"];
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
    Layer.succeed(ProviderBudgetSettlementCallerAuthenticator, {
      authenticate: options?.authenticateSettlement ??
        (() => Effect.succeed(settlementCaller)),
    }),
    Layer.succeed(ProviderBudgetEnforcer, {
      reserve: () => Effect.die("reserve is owned by the policy decision point"),
      settle: () => Effect.die("subject settlement is not an HTTP boundary"),
      settleProvider: options?.settleProvider ?? ((input) => Effect.succeed({
        schemaVersion: 1,
        decisionRef: input.decisionRef,
        outcome: "settled",
        forwardOutcome: input.forwardOutcome,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens,
        spendMicros: input.spendMicros,
        settledAtMillis: input.settledAtMillis,
      })),
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
  maximumSettlementBodyBytes: 4 * 1_024,
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
          maximumSettlementBodyBytes: 4 * 1_024,
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

  it.effect("authenticates a provider Pod and derives settlement authority outside the body", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<unknown>(null);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          settleProvider: (input) =>
            Ref.set(seen, input).pipe(
              Effect.as({
                schemaVersion: 1,
                decisionRef: input.decisionRef,
                outcome: "settled",
                forwardOutcome: input.forwardOutcome,
                inputTokens: input.inputTokens,
                outputTokens: input.outputTokens,
                cachedInputTokens: input.cachedInputTokens,
                spendMicros: input.spendMicros,
                settledAtMillis: input.settledAtMillis,
              }),
            ),
        })),
      );
      const response = yield* handler(settlementRequest());
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
        schemaVersion: 1,
        decisionRef: settlementBody.decisionRef,
        outcome: "settled",
      });
      assert.deepStrictEqual(yield* Ref.get(seen), {
        ...settlementBody,
        provider: "github",
        credentialDomain: "github",
        settledAtMillis: now,
      });
    }));

  it.effect("rejects malformed or oversized settlement bodies before database work", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0);
      const handler = yield* makeHandler.pipe(
        Effect.provide(services({
          settleProvider: (input) =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.as({
                schemaVersion: 1,
                decisionRef: input.decisionRef,
                outcome: "settled",
                forwardOutcome: input.forwardOutcome,
                inputTokens: input.inputTokens,
                outputTokens: input.outputTokens,
                cachedInputTokens: input.cachedInputTokens,
                spendMicros: input.spendMicros,
                settledAtMillis: input.settledAtMillis,
              }),
            ),
        })),
      );
      const excessive = settlementRequest({
        ...settlementBody,
        provider: "github",
      });
      assert.strictEqual((yield* handler(excessive)).status, 400);

      const oversized = settlementRequest(settlementBody);
      oversized.headers.set("content-length", String(4 * 1_024 + 1));
      assert.strictEqual((yield* handler(oversized)).status, 400);
      assert.strictEqual(yield* Ref.get(calls), 0);
    }));

  it.effect("maps settlement identity and dependency failures to finite responses", () =>
    Effect.gen(function*() {
      const handler = yield* makeHandler.pipe(Effect.provide(services()));
      const forbiddenHandler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticateSettlement: () =>
            Effect.fail(
              ProviderBudgetSettlementCallerAuthenticationError.make({
                outcome: "forbidden",
              }),
            ),
        })),
      );
      const unavailableHandler = yield* makeHandler.pipe(
        Effect.provide(services({
          authenticateSettlement: () =>
            Effect.fail(
              ProviderBudgetSettlementCallerAuthenticationError.make({
                outcome: "dependency_unavailable",
              }),
            ),
        })),
      );
      const databaseHandler = yield* makeHandler.pipe(
        Effect.provide(services({
          settleProvider: () =>
            Effect.fail(ProviderBudgetEnforcementError.make({
              outcome: "database_unavailable",
              retryable: true,
              retryAtMillis: null,
            })),
        })),
      );
      const missing = settlementRequest();
      missing.headers.delete("authorization");
      assert.strictEqual((yield* handler(missing)).status, 401);

      assert.strictEqual((yield* forbiddenHandler(settlementRequest())).status, 403);
      assert.strictEqual((yield* unavailableHandler(settlementRequest())).status, 503);
      assert.strictEqual((yield* databaseHandler(settlementRequest())).status, 503);
    }));
});
