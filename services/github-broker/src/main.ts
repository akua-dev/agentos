#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL,
  AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_PATH,
  makeProviderAccessTelemetry,
  ProviderBudgetSettlementReadiness,
  ProviderBudgetSettlementReporter,
  makeProviderBudgetSettlementHttpLayer,
} from "@akua-dev/agentos";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  makeGitHubBrokerHandler,
  serveGitHubBrokerRequest,
  type GitHubBrokerHandler,
} from "./broker.ts";
import { GitHubProviderHttpLive } from "./http.ts";
import { makeGitHubInstallationTokenProvider } from "./token.ts";
import { githubBrokerError } from "./types.ts";
import { GitHubBrokerOtlpLive } from "./otlp.ts";

const BrokerConfig = Config.all({
  apiUrl: Config.url("GITHUB_API_URL").pipe(
    Config.withDefault(new URL("https://api.github.com")),
  ),
  appId: Config.string("GITHUB_APP_ID"),
  gitUrl: Config.url("GITHUB_GIT_URL").pipe(
    Config.withDefault(new URL("https://github.com")),
  ),
  gracefulShutdownMillis: Config.int(
    "GITHUB_BROKER_GRACEFUL_SHUTDOWN_MILLIS",
  ).pipe(Config.withDefault(20_000)),
  hostname: Config.string("GITHUB_BROKER_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  installationId: Config.string("GITHUB_APP_INSTALLATION_ID"),
  installationOwner: Config.string("GITHUB_APP_INSTALLATION_OWNER"),
  port: Config.int("GITHUB_BROKER_LISTEN_PORT").pipe(
    Config.withDefault(8789),
  ),
  readinessRefreshMillis: Config.int(
    "GITHUB_BROKER_READINESS_REFRESH_MILLIS",
  ).pipe(Config.withDefault(60_000)),
  readinessTimeoutMillis: Config.int(
    "GITHUB_BROKER_READINESS_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  privateKeyFile: Config.string("GITHUB_APP_PRIVATE_KEY_FILE"),
  settlementBaseUrl: Config.url(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL",
  ).pipe(
    Config.withDefault(new URL(AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL)),
  ),
  settlementMaximumResponseBytes: Config.int(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_MAX_RESPONSE_BYTES",
  ).pipe(Config.withDefault(1_024)),
  settlementTimeoutMillis: Config.int(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TIMEOUT_MILLIS",
  ).pipe(Config.withDefault(2_000)),
  settlementTokenPath: Config.string(
    "AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_FILE",
  ).pipe(Config.withDefault(AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_PATH)),
});

function makeGitHubBrokerRoutesLayer(
  handler: GitHubBrokerHandler,
  readiness: {
    readonly check: Effect.Effect<void, unknown>;
    readonly timeoutMillis: number;
  },
) {
  return Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap((webRequest) =>
          serveGitHubBrokerRequest(handler, readiness, webRequest)
        ),
        Effect.map(HttpServerResponse.fromWeb),
      ));
  }));
}

const startup = Effect.gen(function*() {
  const config = yield* BrokerConfig;
  if (
    config.port < 1 || config.port > 65_535 ||
    config.hostname.length === 0 || config.hostname.length > 253 ||
    config.gracefulShutdownMillis <= 0 ||
    config.readinessRefreshMillis <= 0 ||
    config.readinessTimeoutMillis <= 0 ||
    config.settlementMaximumResponseBytes <= 0 ||
    config.settlementTimeoutMillis <= 0 ||
    config.settlementTokenPath.length === 0 ||
    config.settlementTokenPath.length > 4_096
  ) {
    return yield* githubBrokerError("invalid_configuration");
  }
  const tokens = yield* makeGitHubInstallationTokenProvider({
    apiUrl: config.apiUrl.toString(),
    appId: config.appId,
    installationId: config.installationId,
    installationOwner: config.installationOwner.toLowerCase(),
    privateKeyFile: config.privateKeyFile,
    readinessRefreshMillis: config.readinessRefreshMillis,
  });
  const settlementLayer = makeProviderBudgetSettlementHttpLayer({
    baseUrl: config.settlementBaseUrl.toString(),
    tokenPath: config.settlementTokenPath,
    timeoutMillis: config.settlementTimeoutMillis,
    maximumResponseBytes: config.settlementMaximumResponseBytes,
  });
  const settlementServices = yield* Effect.all({
    readiness: ProviderBudgetSettlementReadiness,
    reporter: ProviderBudgetSettlementReporter,
  }).pipe(Effect.provide(settlementLayer));
  const telemetry = yield* makeProviderAccessTelemetry();
  const handler = yield* makeGitHubBrokerHandler({
    tokens,
    apiUrl: config.apiUrl.toString(),
    gitUrl: config.gitUrl.toString(),
    settlements: settlementServices.reporter,
    telemetry,
  });
  const readiness = {
    check: Effect.all([
      tokens.check,
      settlementServices.readiness.check,
    ], { concurrency: 2, discard: true }),
    timeoutMillis: config.readinessTimeoutMillis,
  };
  const application = HttpRouter.serve(
    makeGitHubBrokerRoutesLayer(handler, readiness),
    { disableListenLog: true },
  ).pipe(
    Layer.provide(BunHttpServer.layer({
      hostname: config.hostname,
      port: config.port,
      gracefulShutdownTimeout: config.gracefulShutdownMillis,
    })),
  );
  yield* Console.log(JSON.stringify({
    event: "agentos.github_broker.listening",
    hostname: config.hostname,
    port: config.port,
  }));
  return yield* Layer.launch(application);
});

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunFileSystem.layer,
    BunHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
    GitHubProviderHttpLive.pipe(Layer.provide(BunHttpClient.layer)),
  );
  BunRuntime.runMain(startup.pipe(
    Effect.tapError(() =>
      Console.error(JSON.stringify({
        event: "agentos.github_broker.failed",
      }))
    ),
    Effect.provide(GitHubBrokerOtlpLive),
    Effect.provide(platform),
  ));
}
