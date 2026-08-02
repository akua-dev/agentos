#!/usr/bin/env bun

import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { makeA2aRoutesLayer } from "./app.ts";
import {
  loadA2aServiceConfig,
  safeA2aEntrypointFailure,
} from "./config.ts";
import { makeA2aServiceLiveLayer } from "./layers.ts";

const startup = Effect.gen(function*() {
  const config = yield* loadA2aServiceConfig();
  const routes = makeA2aRoutesLayer({
    baseUrl: config.baseUrl,
    maximumBodyBytes: config.maximumBodyBytes,
    requestTimeoutMillis: config.requestTimeoutMillis,
    targets: config.targets,
  }).pipe(Layer.provide(makeA2aServiceLiveLayer(config)));
  const application = HttpRouter.serve(routes, {
    disableListenLog: true,
  }).pipe(
    Layer.provide(BunHttpServer.layer({
      hostname: config.hostname,
      port: config.port,
      gracefulShutdownTimeout: config.gracefulShutdownMillis,
    })),
  );
  yield* Effect.logInfo("agentos.a2a.listening", {
    hostname: config.hostname,
    port: config.port,
  });
  return yield* Layer.launch(application);
});

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunCryptoLayer,
    BunFileSystem.layer,
    BunHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(startup.pipe(
    Effect.tapError((error) =>
      Effect.logError(
        "agentos.a2a.failed",
        safeA2aEntrypointFailure(error),
      )
    ),
    Effect.provide(platform),
  ));
}
