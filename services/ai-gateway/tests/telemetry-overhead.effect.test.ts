import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect } from "effect";

import {
  type AIGatewayTelemetry,
  makeAIGatewayTelemetry,
} from "../src/observability.ts";

const sampleSize = 300;
const averageOverheadBudgetNanos = 750_000;

function lifecycle(telemetry: AIGatewayTelemetry["Service"]) {
  return Effect.gen(function*() {
    const request = yield* telemetry.start(
      new Request("http://ai-gateway.test/v1/responses", {
        headers: {
          "x-agentos-model-family": "gpt-5",
          "x-agentos-request-kind": "main",
          "x-agentos-runtime": "pi",
          "x-agentos-stream-mode": "streaming",
        },
      }),
    );
    yield* request.authenticate(true);
    yield* request.routeStarted;
    yield* request.routeEnded("acquired");
    yield* request.quotaRefresh("fresh");
    yield* request.quotaObservation(0.25, false);
    yield* request.upstreamStarted(new Headers());
    yield* request.upstreamHeaders(200, new Headers());
    yield* request.streamChunk(1_024);
    yield* request.routeReleaseStarted;
    yield* request.routeReleased;
    yield* request.end({ status: 200, streamOutcome: "completed" });
  });
}

function measure(telemetry: AIGatewayTelemetry["Service"], samples: number) {
  return Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeNanos;
    yield* Effect.forEach(
      Array.from({ length: samples }),
      () => lifecycle(telemetry),
      { discard: true },
    );
    const endedAt = yield* Clock.currentTimeNanos;
    return endedAt - startedAt;
  });
}

describe("AI Gateway telemetry overhead budget", () => {
  it.live("stays below the documented average incremental request budget", () =>
    Effect.gen(function*() {
      const enabled = yield* makeAIGatewayTelemetry();
      const disabled = yield* makeAIGatewayTelemetry({ enabled: false });
      yield* measure(enabled, 25);
      yield* measure(disabled, 25);
      const disabledNanos = yield* measure(disabled, sampleSize);
      const enabledNanos = yield* measure(enabled, sampleSize);
      const averageIncrementalNanos = Math.max(
        0,
        Number(enabledNanos - disabledNanos) / sampleSize,
      );
      assert.isBelow(
        averageIncrementalNanos,
        averageOverheadBudgetNanos,
        `average incremental telemetry overhead was ${averageIncrementalNanos}ns`,
      );
    }).pipe(Effect.provide(BunCryptoLayer)));
});
