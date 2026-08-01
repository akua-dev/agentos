import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AIGatewayTelemetry,
  makeLegacyAIGatewayTelemetry,
  noopAIGatewayTelemetry,
} from "../src/observability.ts";
import type {
  GatewayRequestOutcome,
  GatewayTelemetry,
} from "../src/telemetry.ts";
import { createNoopGatewayTelemetry } from "../src/telemetry.ts";

describe("Effect AI Gateway telemetry boundary", () => {
  it.effect("lifts the complete bounded request lifecycle into Effect", () =>
    Effect.gen(function*() {
      const events: Array<unknown> = [];
      const legacy: GatewayTelemetry = {
        enabled: true,
        startRequest() {
          return {
            attemptId: "attempt-safe",
            authenticate: (authenticated) => {
              events.push(["authenticate", authenticated]);
            },
            routeStarted: () => {
              events.push("route_started");
            },
            routeEnded: (outcome) => {
              events.push(["route_ended", outcome]);
            },
            quotaObservation: (age, stale) => {
              events.push(["quota", age, stale]);
            },
            upstreamStarted: (headers) => {
              headers.set("x-client-request-id", "attempt-safe");
              events.push("upstream_started");
            },
            upstreamHeaders: (status) => {
              events.push(["upstream_headers", status]);
            },
            upstreamFailed: () => {
              events.push("upstream_failed");
            },
            streamChunk: (bytes) => {
              events.push(["chunk", bytes]);
            },
            routeReleaseStarted: () => {
              events.push("release_started");
            },
            routeReleased: (error) => {
              events.push(["released", error !== undefined]);
            },
            end: (outcome: GatewayRequestOutcome) => {
              events.push(["end", outcome]);
            },
          };
        },
      };
      const telemetry = makeLegacyAIGatewayTelemetry(legacy);
      const request = yield* telemetry.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      const headers = new Headers();
      yield* request.authenticate(true);
      yield* request.routeStarted;
      yield* request.routeEnded("acquired");
      yield* request.quotaObservation(2, false);
      yield* request.upstreamStarted(headers);
      yield* request.upstreamHeaders(200, new Headers());
      yield* request.streamChunk(11);
      yield* request.routeReleaseStarted;
      yield* request.routeReleased;
      yield* request.end({ status: 200, streamOutcome: "completed" });
      assert.strictEqual(request.attemptId, "attempt-safe");
      assert.strictEqual(headers.get("x-client-request-id"), "attempt-safe");
      assert.deepStrictEqual(events, [
        ["authenticate", true],
        "route_started",
        ["route_ended", "acquired"],
        ["quota", 2, false],
        "upstream_started",
        ["upstream_headers", 200],
        ["chunk", 11],
        "release_started",
        ["released", false],
        ["end", { status: 200, streamOutcome: "completed" }],
      ]);
    }));

  it.effect("contains telemetry defects and provides an inert no-op service", () =>
    Effect.gen(function*() {
      const noopLegacy = createNoopGatewayTelemetry();
      const revoked = Proxy.revocable(noopLegacy.startRequest, {});
      revoked.revoke();
      const defective = makeLegacyAIGatewayTelemetry({
        enabled: true,
        startRequest: revoked.proxy,
      });
      const request = yield* defective.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      yield* request.authenticate(false, undefined, 401);
      yield* request.end({
        error: new Error("private provider payload"),
        streamOutcome: "upstream_error",
      });
      const noop = yield* AIGatewayTelemetry.pipe(
        Effect.provideService(AIGatewayTelemetry, noopAIGatewayTelemetry),
      );
      const noopRequest = yield* noop.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      yield* noopRequest.end({ streamOutcome: "not_streamed" });
      assert.strictEqual(noopRequest.attemptId, "");
    }));
});
