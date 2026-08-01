#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  AGENTOS_OPENFGA_HEALTH_OBJECT,
  AGENTOS_OPENFGA_HEALTH_RELATION,
  AGENTOS_OPENFGA_HEALTH_USER,
  OpenFgaAuthorizationApi,
  OpenFgaDeploymentV1Schema,
} from "../../../packages/agentos/src/access/openfga.ts";
import {
  OpenFgaAuthorizationApiHttpLayer,
  makeOpenFgaHttpTransportLayer,
} from "../../../packages/agentos/src/access/openfga-http.ts";
import {
  readDeploymentFile,
  readRedactedFile,
  safeEntrypointFailure,
} from "./config.ts";

export interface OpenFgaReadinessDependencies {
  readonly nativeHealth: Effect.Effect<boolean, unknown>;
  readonly deployment: Effect.Effect<{
    readonly storeId: string;
    readonly authorizationModelId: string;
  }, unknown>;
  readonly authorizationApi: OpenFgaAuthorizationApi["Service"];
}

export const evaluateOpenFgaSemanticReadiness = Effect.fn(
  "agentos.openfga.evaluateSemanticReadiness",
)(function*(dependencies: OpenFgaReadinessDependencies) {
  const nativeHealthy = yield* dependencies.nativeHealth;
  if (!nativeHealthy) return false;
  const deployment = yield* dependencies.deployment;
  return yield* dependencies.authorizationApi.check({
    ...deployment,
    user: AGENTOS_OPENFGA_HEALTH_USER,
    relation: AGENTOS_OPENFGA_HEALTH_RELATION,
    object: AGENTOS_OPENFGA_HEALTH_OBJECT,
    context: {},
    consistency: "HIGHER_CONSISTENCY",
  });
});

const ReadinessConfig = Config.all({
  baseUrl: Config.url("OPENFGA_BASE_URL"),
  presharedKeyFile: Config.string("OPENFGA_PRESHARED_KEY_FILE"),
  deploymentDirectory: Config.string("OPENFGA_DEPLOYMENT_DIRECTORY"),
  port: Config.int("OPENFGA_READINESS_PORT").pipe(Config.withDefault(8090)),
});

const startup = Effect.gen(function*() {
  const config = yield* ReadinessConfig;
  const presharedKey = yield* readRedactedFile(config.presharedKeyFile);
  const transport = makeOpenFgaHttpTransportLayer({
    baseUrl: config.baseUrl.toString(),
    presharedKey,
    timeoutMillis: 2_000,
    maximumResponseBytes: 64 * 1_024,
  });
  const authorization = OpenFgaAuthorizationApiHttpLayer.pipe(
    Layer.provide(transport),
  );
  const authorizationApi = yield* OpenFgaAuthorizationApi.pipe(
    Effect.provide(authorization),
  );
  const httpClient = yield* HttpClient.HttpClient;
  const nativeHealth = nativeOpenFgaHealth(config.baseUrl, httpClient);
  const fileSystem = yield* FileSystem.FileSystem;
  const deployment = loadDeployment(config.deploymentDirectory).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );
  const handlerRuntime = ManagedRuntime.make(Layer.empty);

  yield* Effect.acquireRelease(
    Effect.sync(() => Bun.serve({
      hostname: "0.0.0.0",
      port: config.port,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") {
          return Response.json({ status: "alive" });
        }
        if (path !== "/readyz") {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        return handlerRuntime.runPromise(
          evaluateOpenFgaSemanticReadiness({
            nativeHealth,
            deployment,
            authorizationApi,
          }).pipe(Effect.catch(() => Effect.succeed(false))),
        ).then((ready) =>
          Response.json(
            { status: ready ? "ready" : "not_ready" },
            { status: ready ? 200 : 503 },
          )
        );
      },
    })),
    (server) =>
      Effect.sync(() => server.stop(false)).pipe(
        Effect.andThen(handlerRuntime.disposeEffect),
      ),
  ).pipe(
    Effect.tap((server) =>
      Console.log(JSON.stringify({
        event: "agentos.openfga.readiness.listening",
        port: server.port,
      }))
    ),
    Effect.andThen(Effect.never),
    Effect.scoped,
  );
});

function nativeOpenFgaHealth(
  baseUrl: URL,
  client: HttpClient.HttpClient,
) {
  return client.get(new URL("/healthz", baseUrl)).pipe(
    Effect.map((response) => response.status >= 200 && response.status < 300),
    Effect.timeoutOrElse({
      duration: 2_000,
      orElse: () => Effect.succeed(false),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function loadDeployment(directory: string) {
  return Effect.gen(function*() {
    const [storeId, authorizationModelId] = yield* Effect.all([
      readDeploymentFile(`${directory}/store-id`),
      readDeploymentFile(`${directory}/authorization-model-id`),
    ]);
    return yield* Schema.decodeUnknownEffect(OpenFgaDeploymentV1Schema)({
      storeId,
      authorizationModelId,
    });
  });
}

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunFileSystem.layer,
    BunHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  const main = startup.pipe(
    Effect.tapError((error) =>
      Console.error(JSON.stringify({
        event: "agentos.openfga.readiness.failed",
        ...safeEntrypointFailure(error),
      }))
    ),
    Effect.provide(platform),
  );
  BunRuntime.runMain(main);
}
