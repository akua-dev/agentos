#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Schedule,
} from "effect";

import {
  OpenFgaAuthorizationApiHttpLayer,
  OpenFgaManagementApiHttpLayer,
  bootstrapOpenFgaAuthorization,
  makeOpenFgaHttpTransportLayer,
} from "../../../packages/agentos/src/access/openfga-http.ts";
import {
  readRedactedFile,
  safeEntrypointFailure,
} from "./config.ts";
import { publishOpenFgaDeployment } from "./kubernetes.ts";

const BootstrapConfig = Config.all({
  baseUrl: Config.url("OPENFGA_BASE_URL"),
  presharedKeyFile: Config.string("OPENFGA_PRESHARED_KEY_FILE"),
  namespace: Config.string("KUBERNETES_NAMESPACE"),
  serviceAccountTokenFile: Config.string(
    "KUBERNETES_SERVICEACCOUNT_TOKEN_FILE",
  ),
  kubernetesHost: Config.string("KUBERNETES_SERVICE_HOST"),
  kubernetesPort: Config.int("KUBERNETES_SERVICE_PORT_HTTPS").pipe(
    Config.withDefault(443),
  ),
});

const program = Effect.gen(function*() {
  const config = yield* BootstrapConfig;
  const [presharedKey, serviceAccountToken] = yield* Effect.all([
    readRedactedFile(config.presharedKeyFile),
    readRedactedFile(config.serviceAccountTokenFile),
  ]);
  const transport = makeOpenFgaHttpTransportLayer({
    baseUrl: config.baseUrl.toString(),
    presharedKey,
    timeoutMillis: 5_000,
    maximumResponseBytes: 512 * 1_024,
  });
  const services = Layer.merge(
    OpenFgaManagementApiHttpLayer.pipe(Layer.provide(transport)),
    OpenFgaAuthorizationApiHttpLayer.pipe(Layer.provide(transport)),
  );
  const deployment = yield* bootstrapOpenFgaAuthorization.pipe(
    Effect.provide(services),
    Effect.retry({
      times: 8,
      schedule: Schedule.exponential("1 second"),
    }),
  );
  yield* publishOpenFgaDeployment({
    apiBaseUrl: `https://${config.kubernetesHost}:${config.kubernetesPort}`,
    namespace: config.namespace,
    serviceAccountToken,
    timeoutMillis: 5_000,
    maximumResponseBytes: 64 * 1_024,
  }, deployment).pipe(
    Effect.retry({
      times: 5,
      schedule: Schedule.exponential("250 millis"),
    }),
  );
  return deployment;
});

if (import.meta.main) {
  const platform = Layer.merge(
    BunFileSystem.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  const main = program.pipe(
    Effect.tap((deployment) =>
      Console.log(JSON.stringify({
        event: "agentos.openfga.bootstrap.complete",
        storeId: deployment.storeId,
        authorizationModelId: deployment.authorizationModelId,
        previousAuthorizationModelId: deployment.previousAuthorizationModelId,
        modelCreated: deployment.modelCreated,
      }))
    ),
    Effect.tapError((error) =>
      Console.error(JSON.stringify({
        event: "agentos.openfga.bootstrap.failed",
        ...safeEntrypointFailure(error),
      }))
    ),
    Effect.provide(platform),
  );
  BunRuntime.runMain(main);
}
