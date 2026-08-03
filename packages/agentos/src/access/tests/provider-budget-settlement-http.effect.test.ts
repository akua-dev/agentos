import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  ProviderBudgetSettlementReadiness,
  ProviderBudgetSettlementReporter,
  makeProviderBudgetSettlementHttpLayer,
} from "../provider-budget-settlement-http.ts";
import type { ProviderBudgetSettlementReportV1 } from "../provider-budget.ts";

const TokenPath = "/settlement/token";
const DecisionRef = "decision_22222222222222222222222222222222";
const report: ProviderBudgetSettlementReportV1 = {
  schemaVersion: 1,
  decisionRef: DecisionRef,
  forwardOutcome: "completed",
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  spendMicros: 0,
};

function httpClientLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      execute(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      )
    ),
  );
}

function tokenFileLayer(tokens: Ref.Ref<ReadonlyArray<string>>) {
  return FileSystem.layerNoop({
    readFileString: (path) =>
      path === TokenPath
        ? Ref.modify(tokens, (values) => [
          values[0] ?? "",
          values.length > 1 ? values.slice(1) : values,
        ])
        : Effect.succeed(""),
  });
}

function clientLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
  tokens: Ref.Ref<ReadonlyArray<string>>,
) {
  return makeProviderBudgetSettlementHttpLayer({
    baseUrl: "http://agentos-egress-authz.agentos.svc.cluster.local:9001",
    tokenPath: TokenPath,
    timeoutMillis: 1_000,
    maximumResponseBytes: 1_024,
  }).pipe(
    Layer.provide(Layer.merge(
      httpClientLayer(execute),
      tokenFileLayer(tokens),
    )),
  );
}

function decodeRequestBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") return Effect.succeed(null);
  return Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);
}

describe("provider budget settlement HTTP client", () => {
  it.effect("proves its rotated Pod identity against authenticated settlement readiness", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>([
        "projected-readiness-token",
        "rotated-readiness-token",
      ]);
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly authorization: string | undefined;
        readonly method: string;
        readonly url: string;
      }>>([]);
      const layer = clientLayer(
        (request) =>
          Ref.update(requests, (current) => [...current, {
            authorization: request.headers.authorization,
            method: request.method,
            url: request.url.toString(),
          }]).pipe(
            Effect.as(Response.json({ status: "ready" })),
          ),
        tokens,
      );
      yield* ProviderBudgetSettlementReadiness.pipe(
        Effect.flatMap((readiness) => readiness.check),
        Effect.provide(layer),
      );
      yield* ProviderBudgetSettlementReadiness.pipe(
        Effect.flatMap((readiness) => readiness.check),
        Effect.provide(layer),
      );
      assert.deepStrictEqual(yield* Ref.get(requests), [{
        authorization: "Bearer projected-readiness-token",
        method: "GET",
        url:
          "http://agentos-egress-authz.agentos.svc.cluster.local:9001/readyz/settlement",
      }, {
        authorization: "Bearer rotated-readiness-token",
        method: "GET",
        url:
          "http://agentos-egress-authz.agentos.svc.cluster.local:9001/readyz/settlement",
      }]);
    }));

  it.effect("fails settlement readiness closed for unusable identity and response state", () =>
    Effect.gen(function*() {
      const cases = [
        { token: "", status: 200, body: { status: "ready" }, code: "credential_unavailable" },
        { token: "token", status: 401, body: {}, code: "unauthorized" },
        { token: "token", status: 403, body: {}, code: "forbidden" },
        { token: "token", status: 503, body: {}, code: "dependency_unavailable" },
        { token: "token", status: 200, body: { status: "not_ready" }, code: "invalid_response" },
        {
          token: "token",
          status: 200,
          body: { status: "ready", padding: "x".repeat(2_048) },
          code: "response_too_large",
        },
      ];
      for (const testCase of cases) {
        const tokens = yield* Ref.make<ReadonlyArray<string>>([testCase.token]);
        const failure = yield* ProviderBudgetSettlementReadiness.pipe(
          Effect.flatMap((readiness) => readiness.check),
          Effect.provide(clientLayer(
            () => Effect.succeed(Response.json(testCase.body, {
              status: testCase.status,
            })),
            tokens,
          )),
          Effect.flip,
        );
        assert.strictEqual(failure.code, testCase.code);
      }
    }));

  it.effect("rereads the rotated Pod token and sends only the closed report", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>([
        "projected-token-one",
        "projected-token-two",
      ]);
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly authorization: string | undefined;
        readonly body: unknown;
        readonly url: string;
      }>>([]);
      const layer = clientLayer(
        Effect.fn("test.providerSettlementHttp.execute")(function*(request) {
          const body = yield* decodeRequestBody(request);
          yield* Ref.update(requests, (current) => [...current, {
            authorization: request.headers.authorization,
            body,
            url: request.url.toString(),
          }]);
          return Response.json({
            schemaVersion: 1,
            decisionRef: DecisionRef,
            outcome: "settled",
          });
        }),
        tokens,
      );
      yield* Effect.gen(function*() {
        const reporter = yield* ProviderBudgetSettlementReporter;
        yield* reporter.report(report);
        yield* reporter.report(report);
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          authorization: "Bearer projected-token-one",
          body: report,
          url:
            "http://agentos-egress-authz.agentos.svc.cluster.local:9001/settle",
        },
        {
          authorization: "Bearer projected-token-two",
          body: report,
          url:
            "http://agentos-egress-authz.agentos.svc.cluster.local:9001/settle",
        },
      ]);
    }));

  it.effect("maps token, authorization, dependency, and malformed response failures finitely", () =>
    Effect.gen(function*() {
      const cases = [
        { token: "", status: 200, body: {}, code: "credential_unavailable" },
        { token: "token", status: 401, body: {}, code: "unauthorized" },
        { token: "token", status: 403, body: {}, code: "forbidden" },
        { token: "token", status: 503, body: {}, code: "dependency_unavailable" },
        { token: "token", status: 200, body: {}, code: "invalid_response" },
      ];
      for (const testCase of cases) {
        const tokens = yield* Ref.make<ReadonlyArray<string>>([testCase.token]);
        const failure = yield* ProviderBudgetSettlementReporter.pipe(
          Effect.flatMap((reporter) => reporter.report(report)),
          Effect.provide(clientLayer(
            () => Effect.succeed(Response.json(testCase.body, {
              status: testCase.status,
            })),
            tokens,
          )),
          Effect.flip,
        );
        assert.strictEqual(failure.code, testCase.code);
      }
    }));
});
