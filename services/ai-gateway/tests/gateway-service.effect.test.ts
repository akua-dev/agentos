import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
  ProviderBudgetReservationRequestError,
  ProviderBudgetReservationRequester,
  ProviderBudgetReservationRequestV1Schema,
  ProviderBudgetSettlementHttpError,
  ProviderBudgetSettlementReadiness,
  ProviderBudgetSettlementReporter,
  providerAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
  type ProviderBudgetReservationRequestV1,
  type ProviderBudgetSettlementReceiptV1,
  type ProviderBudgetSettlementReportV1,
} from "@akua-dev/agentos";
import { Deferred, Effect, Fiber, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  makeAIGatewayApplication,
  type AIGatewayApplicationOptions,
} from "../src/gateway-service.ts";
import {
  AIGatewayTelemetry,
  type AIGatewayRequestTelemetry,
  makeAIGatewayTelemetry,
  noopAIGatewayTelemetry,
} from "../src/observability.ts";
import { AIProviderHttp } from "../src/provider-http.ts";
import { CodexQuota } from "../src/quota.ts";
import {
  AIRoutingState,
  ManagedAccountVault,
} from "../src/state.ts";

const now = 1_785_586_000_000;
const decisionRef = "decision_22222222222222222222222222222222";
const options: AIGatewayApplicationOptions = {
  authentication: { kind: "workload_identity" },
  operatorToken: "operator-secret",
  allowApiKeyFallback: false,
  heartbeatMillis: 40_000,
  maximumUsageEventBytes: 4_096,
  usageCacheMillis: 60_000,
};

function grant(): ProviderAuthorizationGrantV1 {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef,
    expiresAtMillis: now + 15_000,
    credentialDomain: "openai-responses",
    identity: {
      agentId: "10000000-0000-4000-8000-000000000001",
      role: "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId: "20000000-0000-4000-8000-000000000001",
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
  };
}

function workloadGrant(): Extract<
  ProviderAuthorizationGrantV1,
  { readonly model: string }
> {
  return {
    schemaVersion: 1,
    correlationId: "corr_55555555555555555555555555555555",
    decisionRef: "decision_66666666666666666666666666666666",
    expiresAtMillis: now + 15_000,
    credentialDomain: "openai-responses",
    identity: {
      kind: "kubernetes_workload",
      namespace: "hermes-workers",
      serviceAccountName: "hermes-codex",
      policyRevision: 7,
      policyResourceVersion: "18422",
      hermesProfile: "default",
    },
    capability: "openai.responses.create",
    resource: {
      kind: "provider_service",
      provider: "openai",
      service: "responses",
    },
    rateClass: "standard",
    model: "gpt-test",
    limits: {
      requestWindowMillis: 60_000,
      maximumRequests: 1,
      maximumConcurrent: 1,
      tokenWindowMillis: 60_000,
      maximumTokens: 1_000,
      spendWindowMillis: 3_600_000,
      maximumSpendMicros: 1_000,
    },
  };
}

function providerRequest(
  authorization: ProviderAuthorizationGrantV1 = grant(),
): Request {
  const headers = providerAuthorizationGrantHeaders(authorization);
  headers.set("authorization", "Bearer projected-workload-token");
  headers.set("content-type", "application/json");
  headers.set("session-id", "conversation-a");
  return new Request("http://ai-gateway.test/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-test", max_output_tokens: 100, stream: true }),
  });
}

const completedEvent = `data: ${JSON.stringify({
  type: "response.completed",
  response: {
    status: "completed",
    usage: {
      input_tokens: 21,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 8,
    },
  },
})}\n\ndata: [DONE]\n\n`;

interface TestServices {
  readonly vault: ManagedAccountVault["Service"];
  readonly routing: AIRoutingState["Service"];
  readonly quota: CodexQuota["Service"];
  readonly provider: AIProviderHttp["Service"];
  readonly settlements: ProviderBudgetSettlementReporter["Service"];
  readonly settlementReadiness: ProviderBudgetSettlementReadiness["Service"];
  readonly providerRequests: Ref.Ref<ReadonlyArray<Request>>;
  readonly settlementReports: Ref.Ref<ReadonlyArray<
    ProviderBudgetSettlementReportV1
  >>;
  readonly released: Ref.Ref<number>;
  readonly quotaCalls: Ref.Ref<number>;
  readonly credentialCalls: Ref.Ref<number>;
}

const makeTestServices = Effect.fn("test.aiGateway.makeServices")(
  function*(withAccounts: boolean) {
    const providerRequests = yield* Ref.make<ReadonlyArray<Request>>([]);
    const settlementReports = yield* Ref.make<ReadonlyArray<
      ProviderBudgetSettlementReportV1
    >>([]);
    const released = yield* Ref.make(0);
    const quotaCalls = yield* Ref.make(0);
    const credentialCalls = yield* Ref.make(0);
    const accessToken = ["oauth", "provider", "secret"].join("-");
    const reservation = withAccounts
      ? {
          accountId: "managed-a",
          leaseToken: "lease-a",
          expiresAt: now + 60_000,
          decisionReason: "best_candidate",
        }
      : undefined;
    const releaseReservation = Ref.update(released, (count) => count + 1);
    const vault = ManagedAccountVault.of({
      list: Effect.succeed(withAccounts
        ? [{
          id: "managed-a",
          label: "A",
          expiresAt: now + 60_000,
          needsReauth: false,
        }]
        : []),
      addFromOAuth: () => Effect.succeed("managed-a"),
      getFreshCredential: () =>
        Ref.update(credentialCalls, (count) => count + 1).pipe(
          Effect.as({
            providerAccountId: "provider-a",
            accessToken,
            expiresAt: now + 60_000,
          }),
        ),
      remove: () => Effect.succeed(true),
      markNeedsReauth: () => Effect.succeed(true),
    });
    const routing = AIRoutingState.of({
      summary: () => Effect.succeed({
        activeReservations: 0,
        reservationsByAccount: {},
      }),
      acquire: (_input, use) => Effect.gen(function*() {
        const transferred = yield* Ref.make(false);
        return yield* Effect.acquireUseRelease(
          Effect.succeed(reservation),
          (acquired) => use(
            acquired,
            Effect.uninterruptible(Ref.set(transferred, true)),
          ),
          (acquired, exit) => Effect.gen(function*() {
            if (acquired === undefined) return;
            const wasTransferred = yield* Ref.get(transferred);
            if (wasTransferred && exit._tag === "Success") return;
            yield* releaseReservation;
          }),
        );
      }),
      evaluate: () => Effect.succeed(withAccounts
        ? {
          accountId: "managed-a",
          reason: "best_candidate",
          candidates: [],
        }
        : {
          reason: "no_eligible_accounts",
          candidates: [],
        }),
      renew: () => Effect.succeed(true),
      release: () => releaseReservation.pipe(
        Effect.as(true),
      ),
      recordResponse: () => Effect.void,
    });
    const quota = CodexQuota.of({
      observe: (input) => Ref.update(quotaCalls, (count) => count + 1).pipe(
        Effect.as({
          accountId: input.managedAccountId,
          observedAt: now,
          stale: false,
          shortWindow: { usedPercent: 10, resetsAt: now + 3_600_000 },
          weeklyWindow: { usedPercent: 20, resetsAt: now + 86_400_000 },
        }),
      ),
    });
    const provider = AIProviderHttp.of({
      execute: (request) => Ref.update(
        providerRequests,
        (current) => [...current, request],
      ).pipe(
        Effect.as({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: Stream.make(new TextEncoder().encode(completedEvent)),
        }),
      ),
    });
    const settlements = ProviderBudgetSettlementReporter.of({
      report: (report) => {
        const receipt = {
          schemaVersion: 1,
          decisionRef: report.decisionRef,
          outcome: "settled",
        } satisfies ProviderBudgetSettlementReceiptV1;
        return Ref.update(
          settlementReports,
          (current) => [...current, report],
        ).pipe(Effect.as(receipt));
      },
    });
    const settlementReadiness = ProviderBudgetSettlementReadiness.of({
      check: Effect.void,
    });
    return {
      vault,
      routing,
      quota,
      provider,
      settlements,
      settlementReadiness,
      providerRequests,
      settlementReports,
      released,
      quotaCalls,
      credentialCalls,
    } satisfies TestServices;
  },
);

function makeApplication(
  services: TestServices,
  applicationOptions: AIGatewayApplicationOptions = options,
  telemetry: AIGatewayTelemetry["Service"] = noopAIGatewayTelemetry,
  reservationRequester?: ProviderBudgetReservationRequester["Service"],
) {
  const application = makeAIGatewayApplication(applicationOptions).pipe(
    Effect.provideService(ManagedAccountVault, services.vault),
    Effect.provideService(AIRoutingState, services.routing),
    Effect.provideService(CodexQuota, services.quota),
    Effect.provideService(AIProviderHttp, services.provider),
    Effect.provideService(
      ProviderBudgetSettlementReporter,
      services.settlements,
    ),
    Effect.provideService(
      ProviderBudgetSettlementReadiness,
      services.settlementReadiness,
    ),
    Effect.provideService(AIGatewayTelemetry, telemetry),
    Effect.provide(BunCryptoLayer),
  );
  return reservationRequester === undefined
    ? application
    : application.pipe(Effect.provideService(
      ProviderBudgetReservationRequester,
      reservationRequester,
    ));
}

const makeQuotaTelemetryRecorder = Effect.fn(
  "test.aiGateway.makeQuotaTelemetryRecorder",
)(function*() {
  const observations = yield* Ref.make<ReadonlyArray<{
    readonly ageSeconds: number;
    readonly stale: boolean;
  }>>([]);
  const refreshes = yield* Ref.make<ReadonlyArray<string>>([]);
  const requestTelemetry: AIGatewayRequestTelemetry = {
    authenticate: () => Effect.void,
    routeStarted: Effect.void,
    routeEnded: () => Effect.void,
    quotaObservation: (ageSeconds, stale) =>
      Ref.update(observations, (current) => [
        ...current,
        { ageSeconds, stale },
      ]),
    quotaRefresh: (outcome) =>
      Ref.update(refreshes, (current) => [...current, outcome]),
    upstreamStarted: () => Effect.void,
    upstreamHeaders: () => Effect.void,
    upstreamFailed: () => Effect.void,
    streamChunk: () => Effect.void,
    routeReleaseStarted: Effect.void,
    routeReleased: Effect.void,
    routeReleaseFailed: Effect.void,
    end: () => Effect.void,
  };
  return {
    observations,
    refreshes,
    telemetry: AIGatewayTelemetry.of({
      enabled: true,
      start: () => Effect.succeed(requestTelemetry),
    }),
  };
});

describe("Effect AI Gateway application", () => {
  it.effect("rejects a reservation request whose explicit subject differs from its Hermes grant", () =>
    Effect.gen(function*() {
      const grant = workloadGrant();
      const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(
        ProviderBudgetReservationRequestV1Schema,
        { onExcessProperty: "error" },
      )({
        schemaVersion: 1,
        grant,
        subject: {
          ...grant.identity,
          policyResourceVersion: "18423",
        },
      }));

      assert.strictEqual(decoded._tag, "Failure");
    }));

  it.effect("fails Hermes closed before credential access when no shared budget reservation authority exists", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(services);

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
        error: "route_unavailable",
      });
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("passes the exact Hermes grant to an injected non-production reservation interface before forwarding", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const seen = yield* Ref.make<ReadonlyArray<
        ProviderBudgetReservationRequestV1
      >>([]);
      const reservationRequester = ProviderBudgetReservationRequester.of({
        request: (request) => Ref.update(seen, (current) => [
          ...current,
          request,
        ]).pipe(Effect.as({
          schemaVersion: 1,
          outcome: "reserved",
          grant: request.grant,
          subject: request.subject,
        })),
      });
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        reservationRequester,
      );
      const expectedGrant = workloadGrant();

      const response = yield* application.handle(providerRequest(expectedGrant));
      yield* Effect.tryPromise(() => response.arrayBuffer());

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* Ref.get(seen), [{
        schemaVersion: 1,
        grant: expectedGrant,
        subject: expectedGrant.identity,
      }]);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 1);
    }));

  it.effect("denies a rejected Hermes reservation before credential access", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        ProviderBudgetReservationRequester.of({
          request: () => Effect.fail(
            ProviderBudgetReservationRequestError.make({ code: "rejected" }),
          ),
        }),
      );

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("denies a malformed Hermes reservation decision before credential access", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        ProviderBudgetReservationRequester.of({
          request: () => Effect.succeed({ outcome: "reserved" }),
        }),
      );

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("denies an ambiguous Hermes reservation decision before credential access", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        ProviderBudgetReservationRequester.of({
          request: (request) => Effect.succeed({
            schemaVersion: 1,
            outcome: "reserved",
            grant: request.grant,
            subject: request.subject,
            alternateOutcome: "rejected",
          }),
        }),
      );

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("denies a mismatched Hermes reservation decision before credential access", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        ProviderBudgetReservationRequester.of({
          request: (request) => Effect.succeed({
            schemaVersion: 1,
            outcome: "reserved",
            grant: {
              ...request.grant,
              identity: {
                ...request.grant.identity,
                policyResourceVersion: "18423",
              },
            },
            subject: request.subject,
          }),
        }),
      );

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("denies a defective Hermes reservation authority before credential access", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(
        services,
        options,
        noopAIGatewayTelemetry,
        ProviderBudgetReservationRequester.of({
          request: () => Effect.die("reservation authority defect"),
        }),
      );

      const response = yield* application.handle(providerRequest(workloadGrant()));

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("keeps sequential Hermes requests denied without a reservation authority", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(services);

      const first = yield* application.handle(providerRequest(workloadGrant()));
      const second = yield* application.handle(providerRequest(workloadGrant()));

      assert.deepStrictEqual([first.status, second.status], [503, 503]);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("keeps concurrent Hermes requests denied without a reservation authority", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(services);

      const responses = yield* Effect.all([
        application.handle(providerRequest(workloadGrant())),
        application.handle(providerRequest(workloadGrant())),
      ], { concurrency: "unbounded" });

      assert.deepStrictEqual(responses.map(({ status }) => status), [503, 503]);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("does not treat spoofed Hermes task profile or label headers as reservation authority", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(services);
      const request = providerRequest(workloadGrant());
      request.headers.set("x-hermes-task-id", "task-spoof");
      request.headers.set("x-hermes-profile", "admin");
      request.headers.set("x-hermes-pod-label", "budget-authority=true");

      const response = yield* application.handle(request);

      assert.strictEqual(response.status, 503);
      assert.strictEqual((yield* Ref.get(services.providerRequests)).length, 0);
      assert.strictEqual(yield* Ref.get(services.credentialCalls), 0);
    }));

  it.effect("emits bounded quota age and staleness during route acquisition", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const telemetry = yield* makeQuotaTelemetryRecorder();
      const observedAt = now -
        (AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS + 60) * 1_000;
      const application = yield* makeApplication({
        ...services,
        quota: CodexQuota.of({
          observe: (input) =>
            Ref.update(services.quotaCalls, (count) => count + 1).pipe(
              Effect.as({
                accountId: input.managedAccountId,
                observedAt,
                stale: true,
                shortWindow: {
                  usedPercent: 10,
                  resetsAt: now + 3_600_000,
                },
                weeklyWindow: {
                  usedPercent: 20,
                  resetsAt: now + 86_400_000,
                },
              }),
            ),
        }),
      }, options, telemetry.telemetry);
      const response = yield* application.handle(providerRequest());
      yield* Effect.tryPromise(() => response.arrayBuffer());
      assert.deepStrictEqual(yield* Ref.get(telemetry.observations), [{
        ageSeconds: AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
        stale: true,
      }]);
      assert.deepStrictEqual(yield* Ref.get(telemetry.refreshes), ["stale"]);
    }));

  it.effect("distinguishes fresh quota refreshes from cache hits", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const telemetry = yield* makeQuotaTelemetryRecorder();
      const application = yield* makeApplication(
        services,
        options,
        telemetry.telemetry,
      );
      const first = yield* application.handle(providerRequest());
      yield* Effect.tryPromise(() => first.arrayBuffer());
      const second = yield* application.handle(providerRequest());
      yield* Effect.tryPromise(() => second.arrayBuffer());
      assert.deepStrictEqual(yield* Ref.get(telemetry.refreshes), [
        "fresh",
        "cache_hit",
      ]);
      assert.strictEqual(yield* Ref.get(services.quotaCalls), 1);
    }));

  it.effect("routes a healthy OAuth account and settles exact terminal usage", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const application = yield* makeApplication(services);
      const ready = yield* application.handle(
        new Request("http://ai-gateway.test/readyz"),
      );
      assert.strictEqual(ready.status, 200);
      assert.deepStrictEqual(
        yield* Effect.tryPromise(() => ready.json()),
        { reasons: [], status: "ready", version: 1 },
      );
      const response = yield* application.handle(providerRequest());
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        completedEvent,
      );
      const requests = yield* Ref.get(services.providerRequests);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(
        requests[0]?.headers.get("authorization"),
        "Bearer oauth-provider-secret",
      );
      assert.strictEqual(
        requests[0]?.headers.get("chatgpt-account-id"),
        "provider-a",
      );
      assert.strictEqual(yield* Ref.get(services.released), 1);
      assert.strictEqual(yield* Ref.get(services.quotaCalls), 1);
      assert.deepStrictEqual(yield* Ref.get(services.settlementReports), [{
        schemaVersion: 1,
        decisionRef,
        forwardOutcome: "completed",
        inputTokens: 21,
        outputTokens: 8,
        cachedInputTokens: 5,
        spendMicros: 0,
      }]);
    }));

  it.effect("releases a reservation when credential acquisition is interrupted", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const credentialStarted = yield* Deferred.make<void>();
      const credentialCalls = yield* Ref.make(0);
      const application = yield* makeApplication({
        ...services,
        vault: ManagedAccountVault.of({
          ...services.vault,
          getFreshCredential: () => Effect.gen(function*() {
            const call = yield* Ref.modify(
              credentialCalls,
              (count): readonly [number, number] => [count, count + 1],
            );
            if (call === 0) {
              return {
                providerAccountId: "provider-a",
                accessToken: "oauth-provider-secret",
                expiresAt: now + 60_000,
              };
            }
            yield* Deferred.succeed(credentialStarted, undefined);
            return yield* Effect.never;
          }),
        }),
      });
      const requestFiber = yield* Effect.forkChild(Effect.exit(
        application.handle(providerRequest()),
      ));
      yield* Deferred.await(credentialStarted);
      yield* Fiber.interrupt(requestFiber);

      assert.strictEqual(yield* Ref.get(services.released), 1);
    }));

  it.effect("preserves serving behavior with native telemetry enabled and disabled", () =>
    Effect.forEach([true, false], (enabled) =>
      Effect.gen(function*() {
        yield* TestClock.setTime(now);
        const services = yield* makeTestServices(true);
        const telemetry = yield* makeAIGatewayTelemetry({ enabled }).pipe(
          Effect.provide(BunCryptoLayer),
        );
        const application = yield* makeApplication(
          services,
          options,
          telemetry,
        );
        const response = yield* application.handle(providerRequest());
        assert.strictEqual(response.status, 200);
        assert.strictEqual(
          yield* Effect.tryPromise(() => response.text()),
          completedEvent,
        );
        assert.strictEqual(yield* Ref.get(services.released), 1);
      }), { discard: true }));

  it.effect("keeps health public while readiness and status stay honest and protected", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(false);
      const application = yield* makeApplication(services);
      assert.strictEqual(
        (yield* application.handle(new Request("http://ai-gateway.test/healthz"))).status,
        200,
      );
      const ready = yield* application.handle(
        new Request("http://ai-gateway.test/readyz"),
      );
      assert.strictEqual(ready.status, 503);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => ready.json()), {
        reasons: ["provider_credential_unavailable"],
        status: "not_ready",
        version: 1,
      });
      const unauthorized = yield* application.handle(
        new Request("http://ai-gateway.test/status"),
      );
      assert.strictEqual(unauthorized.status, 401);
      const authorized = yield* application.handle(new Request(
        "http://ai-gateway.test/status",
        { headers: { authorization: "Bearer operator-secret" } },
      ));
      assert.strictEqual(authorized.status, 200);
      const statusText = yield* Effect.tryPromise(() => authorized.text());
      assert.notInclude(statusText, "operator-secret");
      assert.notInclude(statusText, "provider-secret");
    }));

  it.effect("fails readiness closed when authenticated budget settlement is unusable", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(true);
      const checks = yield* Ref.make(0);
      const application = yield* makeApplication({
        ...services,
        settlementReadiness: ProviderBudgetSettlementReadiness.of({
          check: Ref.update(checks, (count) => count + 1).pipe(
            Effect.flatMap(() =>
              ProviderBudgetSettlementHttpError.make({
                code: "dependency_unavailable",
                status: 503,
              })
            ),
          ),
        }),
      });
      assert.strictEqual(
        (yield* application.handle(
          new Request("http://ai-gateway.test/healthz"),
        )).status,
        200,
      );
      const response = yield* application.handle(
        new Request("http://ai-gateway.test/readyz"),
      );
      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
        reasons: ["budget_settlement_unavailable"],
        status: "not_ready",
        version: 1,
      });
      const fallbackServices = yield* makeTestServices(false);
      const fallback = yield* makeApplication({
        ...fallbackServices,
        settlementReadiness: ProviderBudgetSettlementReadiness.of({
          check: Ref.update(checks, (count) => count + 1).pipe(
            Effect.flatMap(() =>
              ProviderBudgetSettlementHttpError.make({
                code: "dependency_unavailable",
                status: 503,
              })
            ),
          ),
        }),
      }, {
        ...options,
        allowApiKeyFallback: true,
        openAIApiKey: "fallback-provider-secret",
      });
      assert.strictEqual(
        (yield* fallback.handle(
          new Request("http://ai-gateway.test/readyz"),
        )).status,
        503,
      );
      assert.strictEqual(yield* Ref.get(checks), 2);
    }));

  it.effect("uses the API-key credential only when fallback is explicitly enabled", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now);
      const services = yield* makeTestServices(false);
      const application = yield* makeApplication(services, {
        ...options,
        allowApiKeyFallback: true,
        openAIApiKey: "fallback-provider-secret",
      });
      const ready = yield* application.handle(
        new Request("http://ai-gateway.test/readyz"),
      );
      assert.strictEqual(ready.status, 200);
      const response = yield* application.handle(providerRequest());
      yield* Effect.tryPromise(() => response.arrayBuffer());
      const requests = yield* Ref.get(services.providerRequests);
      assert.strictEqual(
        requests[0]?.headers.get("authorization"),
        "Bearer fallback-provider-secret",
      );
      assert.strictEqual(requests[0]?.headers.has("chatgpt-account-id"), false);
    }));
});
