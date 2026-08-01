import { assert, describe, it } from "@effect/vitest";
import {
  ProviderBudgetSettlementReporter,
  ProviderBudgetSettlementHttpError,
  providerAuthorizationGrantHeaders,
  type ProviderAuthorizationGrantV1,
  type ProviderBudgetSettlementReceiptV1,
  type ProviderBudgetSettlementReportV1,
} from "@akua-dev/agentos";
import { Effect, Fiber, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  makeAIForwardHandler,
  type AIForwardLease,
} from "../src/forward.ts";
import {
  AIProviderHttp,
  AIProviderHttpError,
} from "../src/provider-http.ts";

const now = 1_785_586_000_000;
const decisionRef = "decision_22222222222222222222222222222222";

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

function gatewayRequest(
  authorization: ProviderAuthorizationGrantV1 = grant(),
): Request {
  const headers = providerAuthorizationGrantHeaders(authorization);
  headers.set("authorization", "Bearer projected-workload-token");
  headers.set("content-type", "application/json");
  headers.set("session-id", "conversation-a");
  headers.set("x-agentos-private", "must-be-stripped");
  return new Request("http://ai-gateway.test/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
}

const completedEvent = [
  "data: " + JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      usage: {
        input_tokens: 31,
        input_tokens_details: { cached_tokens: 11 },
        output_tokens: 9,
      },
    },
  }),
  "",
  "data: [DONE]",
  "",
].join("\n");

const encoder = new TextEncoder();

const makeLease = Effect.fn("test.aiForward.makeLease")(function*() {
  const releases = yield* Ref.make(0);
  const renewals = yield* Ref.make(0);
  const lease: AIForwardLease = {
    kind: "openai_api_key",
    accessToken: "provider-secret",
    renew: Ref.updateAndGet(renewals, (count) => count + 1).pipe(
      Effect.as(true),
    ),
    release: Ref.update(releases, (count) => count + 1),
    recordResponse: () => Effect.void,
  };
  return { lease, releases, renewals };
});

const makeSettlementRecorder = Effect.fn(
  "test.aiForward.makeSettlementRecorder",
)(function*() {
  const reports = yield* Ref.make<ReadonlyArray<
    ProviderBudgetSettlementReportV1
  >>([]);
  const settlements = ProviderBudgetSettlementReporter.of({
    report: (report) => {
      const receipt = {
          schemaVersion: 1,
          decisionRef: report.decisionRef,
          outcome: "settled",
        } satisfies ProviderBudgetSettlementReceiptV1;
      return Ref.update(reports, (current) => [...current, report]).pipe(
        Effect.as(receipt),
      );
    },
  });
  return { reports, settlements };
});

describe("Effect AI Gateway forwarding", () => {
  it.effect("authenticates, strips identity, streams unchanged, and settles exact terminal usage", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const upstream = yield* Ref.make<Request | undefined>(undefined);
      const attribution = yield* Ref.make<ProviderAuthorizationGrantV1 | undefined>(undefined);
      const provider = AIProviderHttp.of({
        execute: (request) =>
          Ref.set(upstream, request).pipe(
            Effect.as({
              status: 200,
              headers: { "content-type": "text/event-stream" },
              body: Stream.make(
                encoder.encode(completedEvent.slice(0, 17)),
                encoder.encode(completedEvent.slice(17)),
              ),
            }),
          ),
      });
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: (_session, _signal, authorization) =>
          Ref.set(attribution, authorization).pipe(Effect.as(route.lease)),
        provider,
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        completedEvent,
      );
      assert.deepStrictEqual(yield* Ref.get(attribution), grant());
      const observed = yield* Ref.get(upstream);
      assert.isDefined(observed);
      assert.strictEqual(
        observed?.headers.get("authorization"),
        "Bearer provider-secret",
      );
      assert.deepStrictEqual(
        observed === undefined
          ? []
          : [...observed.headers.keys()].filter((name) =>
            name.startsWith("x-agentos-")
          ),
        [],
      );
      assert.notInclude(
        JSON.stringify(observed === undefined ? [] : [...observed.headers]),
        "projected-workload-token",
      );
      assert.strictEqual(yield* Ref.get(route.releases), 1);
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), [{
        schemaVersion: 1,
        decisionRef,
        forwardOutcome: "completed",
        inputTokens: 31,
        outputTokens: 9,
        cachedInputTokens: 11,
        spendMicros: 0,
      }]);
    }));

  it.effect("fails closed without settlement when a successful stream lacks terminal usage", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.make(encoder.encode(
              'data: {"type":"response.output_text.delta","delta":"secret"}\n\n',
            )),
          }),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      yield* Effect.tryPromise(() => response.arrayBuffer());
      assert.strictEqual(yield* Ref.get(route.releases), 1);
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), []);
    }));

  it.effect("settles provider rejections with zero usage and preserves their status/body", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "7",
            },
            body: Stream.make(encoder.encode('{"error":"rate_limited"}')),
          }),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      assert.strictEqual(response.status, 429);
      assert.strictEqual(response.headers.get("retry-after"), "7");
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        '{"error":"rate_limited"}',
      );
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), [{
        schemaVersion: 1,
        decisionRef,
        forwardOutcome: "provider_rejected",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        spendMicros: 0,
      }]);
    }));

  it.effect("rejects invalid grants before route or provider effects", () =>
    Effect.gen(function*() {
      const acquireCalls = yield* Ref.make(0);
      const providerCalls = yield* Ref.make(0);
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Ref.update(acquireCalls, (count) => count + 1).pipe(
          Effect.as(undefined),
        ),
        provider: AIProviderHttp.of({
          execute: () => Ref.update(providerCalls, (count) => count + 1).pipe(
            Effect.as({ status: 500, headers: {}, body: null }),
          ),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const expired = { ...grant(), expiresAtMillis: now };
      const response = yield* handler(gatewayRequest(expired));
      assert.strictEqual(response.status, 401);
      assert.strictEqual(yield* Ref.get(acquireCalls), 0);
      assert.strictEqual(yield* Ref.get(providerCalls), 0);
    }));

  it.effect("releases the route and returns a finite response when provider connection fails", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.fail(AIProviderHttpError.make({
            code: "provider_unavailable",
          })),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      assert.strictEqual(response.status, 502);
      assert.strictEqual(yield* Ref.get(route.releases), 1);
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), []);
    }));

  it.effect("releases an interrupted downstream stream without releasing an unmeasured budget", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.never,
          }),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      const reader = response.body?.getReader();
      assert.isDefined(reader);
      if (reader !== undefined) {
        yield* Effect.tryPromise(() => reader.cancel("client disconnected"));
      }
      assert.strictEqual(yield* Ref.get(route.releases), 1);
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), []);
    }));

  it.effect("keeps a provider stream failure distinct and does not settle unknown usage", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.fail(AIProviderHttpError.make({
              code: "provider_stream_failed",
            })),
          }),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => response.arrayBuffer()),
      );
      assert.notInclude(String(failure), "provider-secret");
      assert.strictEqual(yield* Ref.get(route.releases), 1);
      assert.deepStrictEqual(yield* Ref.get(settlement.reports), []);
    }));

  it.effect("never replaces a completed provider stream with settlement failure", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlementAttempts = yield* Ref.make(0);
      const settlements = ProviderBudgetSettlementReporter.of({
        report: () => Ref.update(settlementAttempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(
            ProviderBudgetSettlementHttpError.make({
              code: "dependency_unavailable",
              status: 503,
            }),
          )),
        ),
      });
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.make(encoder.encode(completedEvent)),
          }),
        }),
        settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        completedEvent,
      );
      assert.strictEqual(yield* Ref.get(settlementAttempts), 1);
      assert.strictEqual(yield* Ref.get(route.releases), 1);
    }));

  it.effect("renews a live routing lease on the Effect clock and stops after cancellation", () =>
    Effect.gen(function*() {
      const route = yield* makeLease();
      const settlement = yield* makeSettlementRecorder();
      const handler = yield* makeAIForwardHandler({
        authentication: { kind: "workload_identity" },
        acquire: () => Effect.succeed(route.lease),
        provider: AIProviderHttp.of({
          execute: () => Effect.succeed({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.never,
          }),
        }),
        settlements: settlement.settlements,
        now: Effect.succeed(now),
        heartbeatMillis: 40_000,
        maximumUsageEventBytes: 4_096,
      });
      const response = yield* handler(gatewayRequest());
      const reader = response.body?.getReader();
      assert.isDefined(reader);
      if (reader !== undefined) {
        const pending = yield* Effect.forkChild(
          Effect.tryPromise(() => reader.read()),
        );
        yield* TestClock.adjust(40_000);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(route.renewals), 1);
        yield* Effect.tryPromise(() => reader.cancel("test complete"));
        yield* Fiber.interrupt(pending);
        yield* TestClock.adjust(80_000);
        assert.strictEqual(yield* Ref.get(route.renewals), 1);
      }
      assert.strictEqual(yield* Ref.get(route.releases), 1);
    }));
});
