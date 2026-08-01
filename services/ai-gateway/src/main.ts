#!/usr/bin/env bun

import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  initializeAgentOSTelemetryFromEnvironment,
  makeProviderBudgetSettlementHttpLayer,
  ProviderBudgetSettlementReporter,
} from "@akua-dev/agentos";
import {
  ConfigProvider,
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Runtime,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  makeAccountVault,
  makeAccountVaultStore,
} from "./effect-accounts.ts";
import {
  AIGatewayCliOutput,
  AIGatewayOAuth,
  AIGatewayRuntime,
  AIGatewayStatusClient,
  runAIGatewayCli,
} from "./cli.ts";
import {
  aiGatewayEntrypointError,
  type AIGatewayConfig,
  type AIGatewayServeConfig,
  loadAIGatewayConfig,
} from "./config.ts";
import {
  type CodexOAuthClient,
  makeOpenAICodexOAuthClient,
} from "./codex-oauth-effect.ts";
import { makeAIGatewayApplication } from "./gateway-service.ts";
import type { AIForwardClientAuthentication } from "./forward.ts";
import {
  AIGatewayTelemetry,
  makeLegacyAIGatewayTelemetry,
  noopAIGatewayTelemetry,
} from "./observability.ts";
import { AIProviderHttp, AIProviderHttpLive } from "./provider-http.ts";
import { CodexQuota, makeCodexQuotaLayer } from "./quota.ts";
import { makeEffectManagedAccountVaultLayer } from "./managed-account-live.ts";
import { defaultRoutingConfig } from "./selection.ts";
import { makeAIRoutingStateLive } from "./state-live.ts";
import {
  AIRoutingState,
  ManagedAccountVault,
} from "./state.ts";
import { createGatewayTelemetry } from "./telemetry.ts";

class AIGatewayProcessExit extends Data.TaggedError("AIGatewayProcessExit")<{
  readonly code: number;
}> {
  override readonly [Runtime.errorExitCode] = this.code;
}

const AIGatewayCliOutputLive = Layer.succeed(
  AIGatewayCliOutput,
  AIGatewayCliOutput.of({
    line: (value) => Console.log(value),
    error: (value) => Console.error(value),
  }),
);

function makeAIGatewayOAuthLive(oauth: CodexOAuthClient) {
  return Layer.succeed(AIGatewayOAuth, AIGatewayOAuth.of({
    login: (onDeviceCode) =>
      oauth.login(onDeviceCode).pipe(
        Effect.mapError(() => aiGatewayEntrypointError("oauth_unavailable")),
      ),
  }));
}

const AIGatewayStatusClientLive = Layer.effect(
  AIGatewayStatusClient,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const read = Effect.fn("agentos.aiGateway.readStatus")(
      function*(port: number, token: Redacted.Redacted<string>) {
        const request = HttpClientRequest.get(
          `http://127.0.0.1:${port}/status`,
        ).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${Redacted.value(token)}`,
          ),
        );
        return yield* Effect.scoped(Effect.gen(function*() {
          const response = yield* client.execute(request).pipe(
            Effect.mapError(() =>
              aiGatewayEntrypointError("status_unavailable")
            ),
          );
          if (response.status < 200 || response.status >= 300) {
            return yield* aiGatewayEntrypointError("status_unavailable");
          }
          return yield* response.text.pipe(
            Effect.mapError(() =>
              aiGatewayEntrypointError("status_unavailable")
            ),
          );
        }));
      },
    );
    return AIGatewayStatusClient.of({ read });
  }),
);

function acquireAIGatewayTelemetry() {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => initializeAgentOSTelemetryFromEnvironment(),
      catch: () => aiGatewayEntrypointError("telemetry_unavailable"),
    }),
    (telemetry) =>
      Effect.tryPromise({
        try: () => telemetry.shutdown(),
        catch: () => aiGatewayEntrypointError("telemetry_unavailable"),
      }).pipe(Effect.catchCause(() => Effect.void)),
  ).pipe(
    Effect.map((telemetry) =>
      telemetry.enabled
        ? makeLegacyAIGatewayTelemetry(createGatewayTelemetry())
        : noopAIGatewayTelemetry
    ),
  );
}

function makeManagedAccountVaultLive(
  config: AIGatewayConfig,
  path: Path.Path,
  oauth: CodexOAuthClient,
) {
  return Effect.gen(function*() {
    const store = yield* makeAccountVaultStore(
      path.join(config.stateDirectory, "accounts.json"),
    );
    const vault = yield* makeAccountVault({ store, oauth });
    return makeEffectManagedAccountVaultLayer(vault);
  });
}

function makeAIGatewayRuntimeLive(
  config: AIGatewayConfig,
  path: Path.Path,
) {
  return Layer.effect(
    AIGatewayRuntime,
    Effect.gen(function*() {
      const vault = yield* ManagedAccountVault;
      const fileSystem = yield* FileSystem.FileSystem;
      const provider = yield* AIProviderHttp.pipe(
        Effect.provide(AIProviderHttpLive),
      );
      const quota = yield* CodexQuota.pipe(
        Effect.provide(makeCodexQuotaLayer(config.quotaTimeoutMillis)),
      );
      const settlements = yield* ProviderBudgetSettlementReporter.pipe(
        Effect.provide(makeProviderBudgetSettlementHttpLayer({
          baseUrl: config.settlementBaseUrl,
          tokenPath: config.settlementTokenPath,
          timeoutMillis: config.settlementTimeoutMillis,
          maximumResponseBytes: config.settlementMaximumResponseBytes,
        })),
      );

      const serve = Effect.fn("agentos.aiGateway.serve")(
        (serveConfig: AIGatewayServeConfig) => Effect.scoped(Effect.gen(function*() {
          yield* fileSystem.makeDirectory(config.stateDirectory, {
            recursive: true,
          }).pipe(
            Effect.mapError(() =>
              aiGatewayEntrypointError("invalid_configuration")
            ),
          );
          const routing = yield* AIRoutingState.pipe(
            Effect.provide(makeAIRoutingStateLive(
              path.join(config.stateDirectory, "routing.sqlite"),
              defaultRoutingConfig,
            )),
            Effect.mapError(() =>
              aiGatewayEntrypointError("server_unavailable")
            ),
          );
          const telemetry = yield* acquireAIGatewayTelemetry();
          const clientAuthentication: AIForwardClientAuthentication =
            serveConfig.authentication.kind ===
              "workload_identity"
            ? { kind: "workload_identity" }
            : {
                kind: "shared_token",
                token: Redacted.value(serveConfig.authentication.token),
              };
          const openAIApiKey = Redacted.value(serveConfig.openAIApiKey);
          const application = yield* makeAIGatewayApplication({
            authentication: clientAuthentication,
            operatorToken: Redacted.value(serveConfig.operatorToken),
            allowApiKeyFallback: serveConfig.allowApiKeyFallback,
            ...(openAIApiKey === "" ? {} : { openAIApiKey }),
            heartbeatMillis: serveConfig.heartbeatMillis,
            maximumUsageEventBytes: serveConfig.maximumUsageEventBytes,
            usageCacheMillis: serveConfig.usageCacheMillis,
          }).pipe(
            Effect.provideService(ManagedAccountVault, vault),
            Effect.provideService(AIRoutingState, routing),
            Effect.provideService(AIProviderHttp, provider),
            Effect.provideService(CodexQuota, quota),
            Effect.provideService(
              ProviderBudgetSettlementReporter,
              settlements,
            ),
            Effect.provideService(AIGatewayTelemetry, telemetry),
            Effect.mapError(() =>
              aiGatewayEntrypointError("invalid_configuration")
            ),
          );
          const routes = makeAIGatewayRoutesLayer(application);
          const server = HttpRouter.serve(routes, {
            disableListenLog: true,
          }).pipe(
            Layer.provide(BunHttpServer.layer({
              hostname: serveConfig.hostname,
              port: serveConfig.port,
              gracefulShutdownTimeout: serveConfig.gracefulShutdownMillis,
            })),
          );
          return yield* Layer.launch(server).pipe(
            Effect.mapError(() =>
              aiGatewayEntrypointError("server_unavailable")
            ),
          );
        })),
      );
      return AIGatewayRuntime.of({ serve });
    }),
  );
}

function makeAIGatewayRoutesLayer(
  application: { readonly handle: (request: Request) => Effect.Effect<Response> },
) {
  return Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap(application.handle),
        Effect.map(HttpServerResponse.fromWeb),
      ));
  }));
}

const startup = Effect.gen(function*() {
  const config = yield* loadAIGatewayConfig();
  const path = yield* Path.Path;
  const oauth = yield* makeOpenAICodexOAuthClient().pipe(
    Effect.mapError(() => aiGatewayEntrypointError("oauth_unavailable")),
  );
  const accounts = yield* makeManagedAccountVaultLive(config, path, oauth);
  const runtime = makeAIGatewayRuntimeLive(config, path).pipe(
    Layer.provide(accounts),
  );
  const live = Layer.mergeAll(
    accounts,
    runtime,
    AIGatewayCliOutputLive,
    makeAIGatewayOAuthLive(oauth),
    AIGatewayStatusClientLive,
  );
  const args = yield* Effect.sync(() => Bun.argv.slice(2));
  const exitCode = yield* runAIGatewayCli(args, config).pipe(
    Effect.provide(live),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(new AIGatewayProcessExit({ code: exitCode }));
  }
}).pipe(Effect.scoped);

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunCryptoLayer,
    BunFileSystem.layer,
    BunHttpClient.layer,
    BunPath.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(startup.pipe(Effect.provide(platform)), {
    disableErrorReporting: true,
  });
}
