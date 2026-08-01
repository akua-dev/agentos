import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));

const ReleaseSchema = Schema.Struct({
  version: Schema.Literal("1.4.1"),
  tag: Schema.Literal("v1.4.1"),
  commit: Schema.Literal("163ea2146acb7b82082acea30ed691b29079095f"),
  image: Schema.Struct({
    reference: Schema.Literal("cr.agentgateway.dev/agentgateway:v1.4.1"),
    indexDigest: Schema.Literal(
      "sha256:efd79355b89094a8225a9db465d9a01dc656b377f0bab458761b935a13231d29",
    ),
  }),
  helm: Schema.Struct({
    reference: Schema.Literal(
      "oci://cr.agentgateway.dev/charts/agentgateway-standalone",
    ),
    version: Schema.Literal("1.4.1"),
    digest: Schema.Literal(
      "sha256:88b04ce071461841562b7e697a935c5d432c8f4859f7dc46d267791e737820e3",
    ),
    archiveSha256: Schema.Literal(
      "b52cf0f6414c96c49f2d6976e09e24e6a035b913f5023e952cb0f6e95901ec86",
    ),
  }),
  binaries: Schema.Struct({
    darwinArm64: Schema.Literal(
      "f0fdc496b6dfd23f740bf458ff3a80c4453d7fd2397f0851bb42c5e00b6841d7",
    ),
    linuxAmd64: Schema.Literal(
      "20f7b298e0c36eef33e7d612b0d0b91d87d43124f59b01f6e9b730477f66d982",
    ),
    linuxArm64: Schema.Literal(
      "983a0919e30d287ec34ba51a69aa678fb81c5b893a59ae267b29d9fd30365d0e",
    ),
  }),
});

const ValuesSchema = Schema.Struct({
  fullnameOverride: Schema.Literal("agentgateway-openai"),
  namespaceOverride: Schema.Literal("agentos"),
  replicaCount: Schema.Literal(2),
  mode: Schema.Literal("readonly"),
  image: Schema.Literal(
    "cr.agentgateway.dev/agentgateway@sha256:efd79355b89094a8225a9db465d9a01dc656b377f0bab458761b935a13231d29",
  ),
  strategy: Schema.Struct({
    type: Schema.Literal("RollingUpdate"),
    rollingUpdate: Schema.Struct({
      maxSurge: Schema.Literal(1),
      maxUnavailable: Schema.Literal(0),
    }),
  }),
  gateway: Schema.Struct({
    service: Schema.Struct({
      enabled: Schema.Literal(true),
      type: Schema.Literal("ClusterIP"),
      ports: Schema.Array(
        Schema.Struct({
          name: Schema.Literal("openai"),
          port: Schema.Literal(8788),
          targetPort: Schema.Literal(4000),
          protocol: Schema.Literal("TCP"),
        }),
      ),
    }),
  }),
  monitoring: Schema.Struct({ enabled: Schema.Literal(false) }),
  resources: Schema.Struct({
    requests: Schema.Struct({ cpu: Schema.String, memory: Schema.String }),
    limits: Schema.Struct({ cpu: Schema.String, memory: Schema.String }),
  }),
  extraEnv: Schema.Array(
    Schema.Struct({
      name: Schema.Literal("AGENTOS_AI_GATEWAY_TOKEN"),
      valueFrom: Schema.Struct({
        secretKeyRef: Schema.Struct({
          name: Schema.Literal("agentgateway-ai-gateway-client"),
          key: Schema.Literal("token"),
        }),
      }),
    }),
  ),
  config: Schema.Struct({
    config: Schema.Struct({
      adminAddr: Schema.Literal("127.0.0.1:15000"),
      statsAddr: Schema.Literal("0.0.0.0:15020"),
      readinessAddr: Schema.Literal("0.0.0.0:15021"),
      tracing: Schema.Struct({
        otlpEndpoint: Schema.String,
        otlpProtocol: Schema.Literal("grpc"),
      }),
    }),
    gateways: Schema.Struct({
      openai: Schema.Struct({ port: Schema.Literal(4000) }),
    }),
    routes: Schema.Array(
      Schema.Struct({
        gateways: Schema.Array(Schema.Literal("openai")),
        policies: Schema.Struct({
          extAuthz: Schema.Struct({
            host: Schema.String,
            failureMode: Schema.Literal("deny"),
          }),
        }),
        backends: Schema.Array(
          Schema.Struct({
            host: Schema.String,
            policies: Schema.Struct({
              backendAuth: Schema.Struct({
                key: Schema.Literal("$AGENTOS_AI_GATEWAY_TOKEN"),
              }),
            }),
          }),
        ),
      }),
    ),
  }),
});

const readJson = Effect.fn("agentgatewayTest.readJson")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseSchema)),
      ),
    );
});

const readYaml = Effect.fn("agentgatewayTest.readYaml")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => parse(source),
    catch: (cause) => cause,
  });
});

layer(Layer.merge(BunFileSystem.layer, BunPath.layer))(
  "agentgateway pinned deployment contract",
  (it) => {
    it.effect("pins the reviewed release artifacts by immutable digest", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const release = yield* readJson(
          path.join(testDirectory, "../release.json"),
        );
        assert.strictEqual(release.version, "1.4.1");
      }),
    );

    it.effect("renders a private, fail-closed, split-credential topology", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const values = yield* readYaml(
          path.join(testDirectory, "../kubernetes/values.yaml"),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ValuesSchema)));
        assert.strictEqual(values.gateway.service.type, "ClusterIP");
        assert.strictEqual(values.mode, "readonly");
        assert.strictEqual(values.replicaCount, 2);
        assert.strictEqual(
          values.config.routes[0]?.policies.extAuthz.failureMode,
          "deny",
        );
      }),
    );
  },
);
