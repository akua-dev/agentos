#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  ManagedRuntime,
} from "effect";

import {
  makeGitHubBrokerHandler,
  serveGitHubBrokerRequest,
} from "./broker.ts";
import {
  GitHubProviderHttpLive,
} from "./http.ts";
import { makeGitHubInstallationTokenProvider } from "./token.ts";
import { githubBrokerError } from "./types.ts";

const BrokerConfig = Config.all({
  apiUrl: Config.url("GITHUB_API_URL").pipe(
    Config.withDefault(new URL("https://api.github.com")),
  ),
  appId: Config.string("GITHUB_APP_ID"),
  gitUrl: Config.url("GITHUB_GIT_URL").pipe(
    Config.withDefault(new URL("https://github.com")),
  ),
  hostname: Config.string("GITHUB_BROKER_LISTEN_HOST").pipe(
    Config.withDefault("0.0.0.0"),
  ),
  installationId: Config.string("GITHUB_APP_INSTALLATION_ID"),
  installationOwner: Config.string("GITHUB_APP_INSTALLATION_OWNER"),
  port: Config.int("GITHUB_BROKER_LISTEN_PORT").pipe(
    Config.withDefault(8789),
  ),
  privateKeyFile: Config.string("GITHUB_APP_PRIVATE_KEY_FILE"),
});

const startup = Effect.gen(function*() {
  const config = yield* BrokerConfig;
  if (config.port < 1 || config.port > 65_535) {
    return yield* githubBrokerError("invalid_configuration");
  }
  const tokens = yield* makeGitHubInstallationTokenProvider({
    apiUrl: config.apiUrl.toString(),
    appId: config.appId,
    installationId: config.installationId,
    installationOwner: config.installationOwner.toLowerCase(),
    privateKeyFile: config.privateKeyFile,
  });
  const handler = yield* makeGitHubBrokerHandler({
    tokens,
    apiUrl: config.apiUrl.toString(),
    gitUrl: config.gitUrl.toString(),
  });
  const handlerRuntime = ManagedRuntime.make(Layer.empty);

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: config.hostname,
        port: config.port,
        fetch: (request) =>
          handlerRuntime.runPromise(
            serveGitHubBrokerRequest(handler, request),
          ),
      })
    ),
    (server) =>
      Effect.sync(() => server.stop(false)).pipe(
        Effect.andThen(handlerRuntime.disposeEffect),
      ),
  ).pipe(
    Effect.tap((server) =>
      Console.log(JSON.stringify({
        event: "agentos.github_broker.listening",
        hostname: config.hostname,
        port: server.port,
      }))
    ),
    Effect.andThen(Effect.never),
    Effect.scoped,
  );
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
    Effect.provide(platform),
  ));
}
