#!/usr/bin/env bun

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpRouter,
} from "effect/unstable/http";

import {
  AgentGatewayReadinessCheck,
  makeAgentGatewayReadinessRoutesLayer,
  probeAgentGateway,
} from "./readiness.ts";

const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const Port = PositiveInteger.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(65_535)),
);
const ProbeConfigurationSchema = Schema.Struct({
  hostname: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
  ),
  port: Port,
  readinessUrl: Schema.URL,
  metricsUrl: Schema.URL,
  probeTimeoutMillis: PositiveInteger,
  readinessTimeoutMillis: PositiveInteger,
  maximumMetricsBytes: PositiveInteger,
  gracefulShutdownMillis: PositiveInteger,
});

class AgentGatewayReadinessConfigurationError extends Schema.TaggedErrorClass<AgentGatewayReadinessConfigurationError>()(
  "AgentGatewayReadinessConfigurationError",
  {
    code: Schema.Literal("invalid_configuration"),
  },
) {}

const ProbeConfig = Config.all({
  hostname: Config.string("AGENTGATEWAY_READINESS_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  port: Config.int("AGENTGATEWAY_READINESS_PORT").pipe(
    Config.withDefault(15_022),
  ),
  readinessUrl: Config.url("AGENTGATEWAY_NATIVE_READINESS_URL").pipe(
    Config.withDefault(new URL("http://127.0.0.1:15021/healthz/ready")),
  ),
  metricsUrl: Config.url("AGENTGATEWAY_METRICS_URL").pipe(
    Config.withDefault(new URL("http://127.0.0.1:15020/metrics")),
  ),
  probeTimeoutMillis: Config.int("AGENTGATEWAY_PROBE_TIMEOUT_MILLIS").pipe(
    Config.withDefault(1_500),
  ),
  readinessTimeoutMillis: Config.int(
    "AGENTGATEWAY_READINESS_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  maximumMetricsBytes: Config.int(
    "AGENTGATEWAY_MAXIMUM_METRICS_BYTES",
  ).pipe(Config.withDefault(256 * 1_024)),
  gracefulShutdownMillis: Config.int(
    "AGENTGATEWAY_READINESS_GRACEFUL_SHUTDOWN_MILLIS",
  ).pipe(Config.withDefault(10_000)),
});

const startup = Effect.gen(function*() {
  const raw = yield* ProbeConfig;
  const config = yield* Schema.decodeUnknownEffect(ProbeConfigurationSchema)(
    raw,
  ).pipe(
    Effect.mapError(() =>
      AgentGatewayReadinessConfigurationError.make({
        code: "invalid_configuration",
      })
    ),
  );
  const client = yield* HttpClient.HttpClient;
  const check = Effect.scoped(probeAgentGateway(client, config)).pipe(
    Effect.timeoutOrElse({
      duration: config.probeTimeoutMillis,
      orElse: () => Effect.succeed(false),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );
  const readiness = Layer.succeed(AgentGatewayReadinessCheck, { check });
  const routes = makeAgentGatewayReadinessRoutesLayer({
    readinessTimeoutMillis: config.readinessTimeoutMillis,
  }).pipe(Layer.provide(readiness));
  const application = HttpRouter.serve(routes, {
    disableListenLog: true,
  }).pipe(
    Layer.provide(BunHttpServer.layer({
      hostname: config.hostname,
      port: config.port,
      gracefulShutdownTimeout: config.gracefulShutdownMillis,
    })),
  );
  yield* Console.log(JSON.stringify({
    event: "agentos.agentgateway_readiness.listening",
    hostname: config.hostname,
    port: config.port,
  }));
  return yield* Layer.launch(application);
});

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(startup.pipe(
    Effect.tapError(() =>
      Console.error(JSON.stringify({
        event: "agentos.agentgateway_readiness.failed",
      }))
    ),
    Effect.provide(platform),
  ));
}
