import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Logger,
  Metric,
  Ref,
  References,
  Tracer,
} from "effect";

import {
  type GatewayRequestOutcome,
  makeAIGatewayTelemetry,
} from "../src/observability.ts";

interface CapturedLog {
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly message: unknown;
  readonly spanId?: string;
  readonly traceId?: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) => typeof entry === "bigint" ? String(entry) : entry,
  );
}

interface TerminalCase {
  readonly error?: Readonly<Record<string, string>>;
  readonly errorClass: string;
  readonly name: string;
  readonly status?: number;
  readonly statusClass: string;
  readonly streamOutcome: GatewayRequestOutcome["streamOutcome"];
}

const terminalCases: ReadonlyArray<TerminalCase> = [
  {
    error: undefined,
    errorClass: "rate_limit",
    name: "429",
    status: 429,
    statusClass: "client_error",
    streamOutcome: "upstream_error",
  },
  {
    error: undefined,
    errorClass: "overload",
    name: "503",
    status: 503,
    statusClass: "server_error",
    streamOutcome: "upstream_error",
  },
  {
    error: undefined,
    errorClass: "unavailable",
    name: "other 5xx",
    status: 500,
    statusClass: "server_error",
    streamOutcome: "upstream_error",
  },
  {
    error: { name: "TimeoutException" },
    errorClass: "timeout",
    name: "timeout",
    status: undefined,
    statusClass: "error",
    streamOutcome: "upstream_error",
  },
  {
    error: { code: "ECONNRESET" },
    errorClass: "transport",
    name: "connection reset",
    status: undefined,
    statusClass: "error",
    streamOutcome: "upstream_error",
  },
  {
    error: { code: "terminal_usage_invalid" },
    errorClass: "decode",
    name: "malformed SSE",
    status: 200,
    statusClass: "error",
    streamOutcome: "upstream_error",
  },
  {
    error: { code: "ERR_ENCODING_INVALID_ENCODED_DATA" },
    errorClass: "decode",
    name: "encoded response",
    status: 200,
    statusClass: "error",
    streamOutcome: "upstream_error",
  },
  {
    error: { name: "AbortError" },
    errorClass: "abort",
    name: "client disconnect",
    status: undefined,
    statusClass: "cancelled",
    streamOutcome: "client_disconnect",
  },
];

describe("Effect AI Gateway telemetry terminal safety", () => {
  it.effect("classifies every terminal path, correlates failures, and restores gauges", () =>
    Effect.gen(function*() {
      const secret =
        "SEED_PROMPT sk-seeded-secret provider-account@example.test tool-private";
      const ids = yield* Ref.make(0);
      const spans: Array<Tracer.NativeSpan> = [];
      const logs: Array<CapturedLog> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logger = Logger.make<unknown, void>((options) => {
        const span = options.fiber.currentSpan;
        logs.push({
          annotations: options.fiber.getRef(
            References.CurrentLogAnnotations,
          ),
          message: options.message,
          ...(span === undefined
            ? {}
            : { spanId: span.spanId, traceId: span.traceId }),
        });
      });
      const telemetry = yield* makeAIGatewayTelemetry({
        nextId: Ref.getAndUpdate(ids, (value) => value + 1).pipe(
          Effect.map((value) => `attempt-${value + 1}`),
        ),
      });

      const exercise = Effect.gen(function*() {
        for (const [index, terminal] of terminalCases.entries()) {
          const request = yield* telemetry.start(new Request(
            "http://ai-gateway.test/v1/responses",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${secret}`,
                baggage: `private=${secret}`,
                "x-agentos-model-family": "gpt-5",
                "x-agentos-request-kind": "main",
              },
            },
          ));
          yield* request.authenticate(true);
          yield* request.routeStarted;
          yield* request.routeEnded("acquired");
          const headers = new Headers();
          yield* request.upstreamStarted(headers);
          yield* request.upstreamHeaders(
            terminal.status ?? 200,
            new Headers({
              "x-request-id": index === 0
                ? "req_safe_provider_1"
                : secret,
            }),
          );
          yield* request.streamChunk(17);
          if (terminal.error !== undefined) {
            yield* request.upstreamFailed({
              ...terminal.error,
              message: secret,
            });
          }
          if (index % 2 === 0) {
            yield* request.routeReleaseStarted;
            yield* request.routeReleased;
          }
          yield* request.end({
            ...(terminal.status === undefined
              ? {}
              : { status: terminal.status }),
            ...(terminal.error === undefined
              ? {}
              : {
                  error: { ...terminal.error, message: secret },
                }),
            streamOutcome: terminal.streamOutcome,
          });
          yield* request.end({
            status: 599,
            error: new Error(secret),
            streamOutcome: "upstream_error",
          });
          assert.match(
            headers.get("x-client-request-id") ?? "",
            /^attempt-[0-9]+$/,
          );
        }
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([logger])),
      );
      yield* exercise;

      const requests = spans.filter(({ name }) =>
        name === "ai-gateway.request"
      );
      assert.lengthOf(requests, terminalCases.length);
      for (const [index, terminal] of terminalCases.entries()) {
        assert.strictEqual(
          requests[index]?.attributes.get("agentos.ai.error.class"),
          terminal.errorClass,
          terminal.name,
        );
        assert.strictEqual(
          requests[index]?.attributes.get("agentos.ai.status_class"),
          terminal.statusClass,
          terminal.name,
        );
      }
      assert.lengthOf(logs, terminalCases.length);
      for (const log of logs) {
        assert.deepStrictEqual(log.message, ["ai_gateway_failure"]);
        assert.match(String(log.annotations.trace_id), /^[0-9a-f]{32}$/);
        assert.match(String(log.annotations.span_id), /^[0-9a-f]{16}$/);
        assert.strictEqual(log.traceId, log.annotations.trace_id);
        assert.strictEqual(log.spanId, log.annotations.span_id);
      }
      assert.strictEqual(
        logs[0]?.annotations["agentos.ai.provider.request_id"],
        "req_safe_provider_1",
      );

      const metrics = yield* Metric.snapshot;
      const active = metrics.filter(({ id }) =>
        id === "agentos.ai.streams.active" ||
        id === "agentos.ai.route.reservations.active"
      );
      assert.lengthOf(active, 2);
      for (const metric of active) {
        assert.strictEqual(
          "count" in metric.state ? metric.state.count : undefined,
          0,
          metric.id,
        );
      }
      const serialized = serialize({
        logs,
        metrics,
        spans: spans.map((span) => ({
          attributes: Object.fromEntries(span.attributes),
          events: span.events,
          name: span.name,
          status: span.status,
        })),
      });
      for (const forbidden of [
        "SEED_PROMPT",
        "sk-seeded-secret",
        "provider-account@example.test",
        "tool-private",
      ]) {
        assert.notInclude(serialized, forbidden);
      }
      assert.notInclude(serialize(metrics), "attempt-");
      assert.notInclude(serialize(metrics), "req_safe_provider_1");
    }).pipe(Effect.provide(BunCryptoLayer)));

  it.effect("keeps disabled telemetry inert", () =>
    Effect.gen(function*() {
      const telemetry = yield* makeAIGatewayTelemetry({ enabled: false });
      assert.isFalse(telemetry.enabled);
      const request = yield* telemetry.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      const headers = new Headers();
      yield* request.authenticate(false, undefined, 401);
      yield* request.routeStarted;
      yield* request.routeEnded("unavailable");
      yield* request.quotaRefresh("failed", new Error("private"));
      yield* request.upstreamStarted(headers);
      yield* request.end({ status: 503, streamOutcome: "not_streamed" });
      assert.deepStrictEqual([...headers], []);
    }).pipe(Effect.provide(BunCryptoLayer)));
});
