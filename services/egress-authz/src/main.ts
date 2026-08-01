#!/usr/bin/env bun

import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  ConfigProvider,
  Console,
  Effect,
  Layer,
} from "effect";
import { HttpRouter } from "effect/unstable/http";

import { makeEgressAuthorizerRoutesLayer } from "./app.ts";
import {
  loadEgressAuthorizerConfig,
  safeEgressAuthorizerEntrypointFailure,
} from "./config.ts";
import { makeEgressAuthorizerLiveLayer } from "./layers.ts";

const startup = Effect.gen(function*() {
  const config = yield* loadEgressAuthorizerConfig();
  const live = makeEgressAuthorizerLiveLayer(config);
  const routes = makeEgressAuthorizerRoutesLayer({
    maximumConcurrentRequests: config.maximumConcurrentRequests,
    requestTimeoutMillis: config.requestTimeoutMillis,
    readinessTimeoutMillis: config.readinessTimeoutMillis,
    maximumHeaderCount: config.maximumHeaderCount,
    maximumHeaderBytes: config.maximumHeaderBytes,
    maximumHeaderValueBytes: config.maximumHeaderValueBytes,
  }).pipe(Layer.provide(live));
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
    event: "agentos.egress_authz.listening",
    hostname: config.hostname,
    port: config.port,
  }));
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
      Console.error(JSON.stringify({
        event: "agentos.egress_authz.failed",
        ...safeEgressAuthorizerEntrypointFailure(error),
      }))
    ),
    Effect.provide(platform),
  ));
}
