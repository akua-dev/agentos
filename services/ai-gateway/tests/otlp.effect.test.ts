import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import { Clock, ConfigProvider, Effect } from "effect";

import { makeAIGatewayTelemetry } from "../src/observability.ts";
import { AIGatewayOtlpLive } from "../src/otlp.ts";

const unavailableCollectorConfig = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_BSP_SCHEDULE_DELAY: "1",
      OTEL_BLRP_SCHEDULE_DELAY: "1",
      OTEL_METRIC_EXPORT_INTERVAL: "1",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "1",
      OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: "1",
      OTEL_EXPORTER_OTLP_TIMEOUT: "20",
    },
  }),
);

describe("Effect OTLP export boundary", () => {
  it.live("does not hold a request when the Collector is unavailable", () =>
    Effect.scoped(Effect.gen(function*() {
      const telemetry = yield* makeAIGatewayTelemetry();
      const startedAt = yield* Clock.currentTimeNanos;
      const request = yield* telemetry.start(
        new Request("http://ai-gateway.test/v1/responses"),
      );
      yield* request.authenticate(true);
      yield* request.routeStarted;
      yield* request.routeEnded("unavailable");
      yield* request.end({ status: 503, streamOutcome: "not_streamed" });
      const completedAt = yield* Clock.currentTimeNanos;
      yield* Effect.sleep("25 millis");
      const latencyMillis = Number(completedAt - startedAt) / 1_000_000;
      assert.isBelow(latencyMillis, 250);
    })).pipe(
      Effect.provide(AIGatewayOtlpLive),
      Effect.provide(unavailableCollectorConfig),
      Effect.provide(BunCryptoLayer),
    ));
});
