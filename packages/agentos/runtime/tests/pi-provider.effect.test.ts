import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  reconcilePiConfigurationEffect,
} from "../pi-provider.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObject);
type JsonObject = typeof JsonObject.Type;

const gatewayEnvironment = {
  AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
  AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
  AGENTOS_THINKING: "xhigh",
  AI_GATEWAY_URL:
    "http://agentgateway-openai.agentos.svc.cluster.local:8788/",
};

const managedGatewayProvider = {
  apiKey:
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder",
  baseUrl: "http://agentgateway-openai.agentos.svc.cluster.local:8788",
};

const fixture = Effect.fn("test.piProvider.fixture")(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-pi-provider-",
  });
  const piAgentDirectory = paths.join(root, "home", ".pi", "agent");
  const stateDirectory = paths.join(
    root,
    "home",
    ".local",
    "state",
    "agentos",
  );
  yield* Effect.all([
    fileSystem.makeDirectory(piAgentDirectory, {
      mode: 0o700,
      recursive: true,
    }),
    fileSystem.makeDirectory(stateDirectory, {
      mode: 0o700,
      recursive: true,
    }),
  ]);
  return {
    auth: paths.join(piAgentDirectory, "auth.json"),
    marker: paths.join(stateDirectory, "pi-provider.json"),
    models: paths.join(piAgentDirectory, "models.json"),
    piAgentDirectory,
    settings: paths.join(piAgentDirectory, "settings.json"),
    stateDirectory,
  };
});

function reconcile(
  paths: Effect.Success<ReturnType<typeof fixture>>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return reconcilePiConfigurationEffect({
    environment,
    piAgentDirectory: paths.piAgentDirectory,
    stateDirectory: paths.stateDirectory,
  });
}

const writeJson = Effect.fn("test.piProvider.writeJson")(
  function*(path: string, value: JsonObject) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const source = yield* Schema.encodeEffect(JsonObjectFromString)(value);
    yield* fileSystem.makeDirectory(paths.dirname(path), {
      mode: 0o700,
      recursive: true,
    });
    yield* fileSystem.writeFileString(path, `${source}\n`, { mode: 0o600 });
    yield* fileSystem.chmod(path, 0o600);
  },
);

const json = Effect.fn("test.piProvider.json")(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(JsonObjectFromString)(
    yield* fileSystem.readFileString(path),
  );
});

function record(value: unknown) {
  return Schema.decodeUnknownEffect(JsonObject)(value);
}

describe("Effect Pi provider reconciliation", () => {
  layer(BunServices.layer)((it) => {
    it.effect(
      "selects a native direct model on a fresh PVC without creating provider state",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();

          yield* reconcile(paths, {
            AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
            AGENTOS_PI_PROVIDER_MODE: "direct",
          });

          assert.deepStrictEqual(yield* json(paths.settings), {
            defaultModel: "gpt-5.6-sol",
            defaultProvider: "openai-codex",
          });
          assert.isFalse(yield* fileSystem.exists(paths.models));
          assert.isFalse(yield* fileSystem.exists(paths.marker));
        })),
    );

    it.effect(
      "creates a private native Gateway provider and exact selected defaults",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();

          yield* reconcile(paths, gatewayEnvironment);

          const models = yield* json(paths.models);
          const providers = yield* record(models.providers);
          assert.deepStrictEqual(
            providers["openai-codex"],
            managedGatewayProvider,
          );
          assert.deepStrictEqual(yield* json(paths.settings), {
            defaultModel: "gpt-5.6-sol",
            defaultProvider: "openai-codex",
            defaultThinkingLevel: "xhigh",
          });
          const marker = yield* json(paths.marker);
          assert.strictEqual(marker._tag, "Active");
          assert.deepStrictEqual(marker.entry, providers["openai-codex"]);
          assert.strictEqual(marker.version, 1);
          for (const path of [paths.models, paths.settings, paths.marker]) {
            assert.strictEqual(
              (yield* fileSystem.stat(path)).mode & 0o777,
              0o600,
            );
          }
          assert.notInclude(
            yield* fileSystem.readFileString(paths.models),
            "AI_GATEWAY_TOKEN",
          );
        })),
    );

    it.effect(
      "preserves unrelated providers, settings, and direct auth across idempotent retry",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();
          const auth = {
            "openai-codex": { type: "oauth", access: "preserved" },
          };
          yield* Effect.all([
            writeJson(paths.auth, auth),
            writeJson(paths.models, {
              providers: {
                local: {
                  api: "openai-completions",
                  apiKey: "local",
                  baseUrl: "http://localhost:11434/v1",
                  models: [{ id: "qwen" }],
                },
              },
            }),
            writeJson(paths.settings, { theme: "agent-owned" }),
          ]);

          const environment = {
            AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
            AI_GATEWAY_URL:
              "http://agentgateway-openai.agentos.svc.cluster.local:8788",
          };
          yield* reconcile(paths, environment);
          const first = yield* Effect.all([
            fileSystem.readFileString(paths.models),
            fileSystem.readFileString(paths.settings),
            fileSystem.readFileString(paths.marker),
          ]);
          yield* reconcile(paths, environment);

          assert.deepStrictEqual(yield* json(paths.auth), auth);
          assert.deepStrictEqual(yield* json(paths.settings), {
            theme: "agent-owned",
          });
          const models = yield* json(paths.models);
          const providers = yield* record(models.providers);
          const local = yield* record(providers.local);
          assert.deepStrictEqual(local.models, [{ id: "qwen" }]);
          assert.deepStrictEqual(
            yield* Effect.all([
              fileSystem.readFileString(paths.models),
              fileSystem.readFileString(paths.settings),
              fileSystem.readFileString(paths.marker),
            ]),
            first,
          );
        })),
    );

    it.effect(
      "removes only the marker-owned provider during explicit direct rollback",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();
          yield* writeJson(paths.models, {
            providers: {
              local: {
                api: "openai-completions",
                apiKey: "local",
                baseUrl: "http://localhost:11434/v1",
                models: [{ id: "qwen" }],
              },
            },
          });
          yield* writeJson(paths.auth, {
            "openai-codex": { access: "preserved", type: "oauth" },
          });
          yield* reconcile(paths, gatewayEnvironment);

          yield* reconcile(paths, { AGENTOS_PI_PROVIDER_MODE: "direct" });

          const models = yield* json(paths.models);
          const providers = yield* record(models.providers);
          const local = yield* record(providers.local);
          assert.deepStrictEqual(local.models, [{ id: "qwen" }]);
          assert.isUndefined(providers["openai-codex"]);
          assert.isFalse(yield* fileSystem.exists(paths.marker));
          assert.deepStrictEqual(yield* json(paths.auth), {
            "openai-codex": { access: "preserved", type: "oauth" },
          });
          assert.deepStrictEqual(yield* json(paths.settings), {
            defaultModel: "gpt-5.6-sol",
            defaultProvider: "openai-codex",
            defaultThinkingLevel: "xhigh",
          });
          yield* reconcile(paths, { AGENTOS_PI_PROVIDER_MODE: "direct" });
          assert.deepStrictEqual(yield* json(paths.models), models);
        })),
    );

    it.effect(
      "requires an explicit direct rollout before removing Gateway configuration",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const paths = yield* fixture();
          yield* reconcile(paths, gatewayEnvironment);

          const failure = yield* reconcile(paths, {}).pipe(Effect.flip);
          assert.include(
            failure.message,
            "must remain configured until direct rollback completes",
          );
          const models = yield* json(paths.models);
          const providers = yield* record(models.providers);
          assert.deepStrictEqual(
            providers["openai-codex"],
            managedGatewayProvider,
          );
          assert.strictEqual((yield* json(paths.marker))._tag, "Active");
        })),
    );

    it.effect(
      "fails closed on an unowned provider collision before changing settings",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();
          const models = {
            providers: {
              "openai-codex": {
                baseUrl: "https://user-proxy.example/v1",
              },
            },
          };
          const settings = { theme: "preserved" };
          yield* Effect.all([
            writeJson(paths.models, models),
            writeJson(paths.settings, settings),
          ]);

          const failure = yield* reconcile(paths, gatewayEnvironment).pipe(
            Effect.flip,
          );
          assert.include(
            failure.message,
            "openai-codex provider is not owned by AgentOS",
          );
          assert.deepStrictEqual(yield* json(paths.models), models);
          assert.deepStrictEqual(yield* json(paths.settings), settings);
          assert.isFalse(yield* fileSystem.exists(paths.marker));
        })),
    );

    it.effect(
      "finishes interrupted provider swaps and fails closed on divergent state",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const beforeSwap = yield* fixture();
          yield* writeJson(beforeSwap.marker, {
            _tag: "Pending",
            desired: managedGatewayProvider,
            previous: null,
            version: 1,
          });

          yield* reconcile(beforeSwap, gatewayEnvironment);
          const beforeProviders = yield* record(
            (yield* json(beforeSwap.models)).providers,
          );
          assert.deepStrictEqual(
            beforeProviders["openai-codex"],
            managedGatewayProvider,
          );
          const beforeMarker = yield* json(beforeSwap.marker);
          assert.strictEqual(beforeMarker._tag, "Active");
          assert.deepStrictEqual(beforeMarker.entry, managedGatewayProvider);

          const afterSwap = yield* fixture();
          yield* Effect.all([
            writeJson(afterSwap.models, {
              providers: { "openai-codex": managedGatewayProvider },
            }),
            writeJson(afterSwap.marker, {
              _tag: "Pending",
              desired: managedGatewayProvider,
              previous: null,
              version: 1,
            }),
          ]);

          yield* reconcile(afterSwap, gatewayEnvironment);
          const afterMarker = yield* json(afterSwap.marker);
          assert.strictEqual(afterMarker._tag, "Active");
          assert.deepStrictEqual(afterMarker.entry, managedGatewayProvider);

          const divergent = yield* fixture();
          const userProvider = {
            baseUrl: "https://user-proxy.example/v1",
          };
          yield* Effect.all([
            writeJson(divergent.models, {
              providers: { "openai-codex": userProvider },
            }),
            writeJson(divergent.marker, {
              _tag: "Pending",
              desired: managedGatewayProvider,
              previous: null,
              version: 1,
            }),
          ]);

          const failure = yield* reconcile(divergent, gatewayEnvironment).pipe(
            Effect.flip,
          );
          assert.include(
            failure.message,
            "changed during an AgentOS reconciliation",
          );
          const divergentProviders = yield* record(
            (yield* json(divergent.models)).providers,
          );
          assert.deepStrictEqual(
            divergentProviders["openai-codex"],
            userProvider,
          );
        })),
    );

    it.effect(
      "fails before writing on malformed JSON or incomplete Gateway inputs",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();
          yield* fileSystem.writeFileString(paths.settings, "[]\n", {
            mode: 0o600,
          });

          const wrongShape = yield* reconcile(paths, gatewayEnvironment).pipe(
            Effect.flip,
          );
          assert.include(
            wrongShape.message,
            "settings.json must contain a JSON object",
          );
          assert.isFalse(yield* fileSystem.exists(paths.models));
          assert.isFalse(yield* fileSystem.exists(paths.marker));

          yield* fileSystem.remove(paths.settings);
          const missingUrl = yield* reconcile(paths, {
            AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
          }).pipe(Effect.flip);
          assert.include(
            missingUrl.message,
            "AI_GATEWAY_URL must be configured",
          );
          assert.isFalse(yield* fileSystem.exists(paths.models));

          yield* fileSystem.writeFileString(paths.models, "{\n", {
            mode: 0o600,
          });
          const malformed = yield* reconcile(paths, gatewayEnvironment).pipe(
            Effect.flip,
          );
          assert.include(
            malformed.message,
            "models.json must contain valid JSON",
          );
          assert.strictEqual(
            yield* fileSystem.readFileString(paths.models),
            "{\n",
          );
          assert.isFalse(yield* fileSystem.exists(paths.marker));
        })),
    );

    it.effect(
      "rejects unsupported modes, unsafe URLs, wrong providers, and unknown models",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture();
          assert.include(
            (yield* reconcile(paths, {
              AGENTOS_PI_PROVIDER_MODE: "automatic",
            }).pipe(Effect.flip)).message,
            "AGENTOS_PI_PROVIDER_MODE",
          );
          assert.include(
            (yield* reconcile(paths, {
              ...gatewayEnvironment,
              AI_GATEWAY_URL: "file:///tmp/not-http",
            }).pipe(Effect.flip)).message,
            "AI_GATEWAY_URL must use http or https",
          );
          assert.include(
            (yield* reconcile(paths, {
              ...gatewayEnvironment,
              AGENTOS_MODEL: "anthropic/claude-sonnet-4",
            }).pipe(Effect.flip)).message,
            "must select openai-codex",
          );
          assert.include(
            (yield* reconcile(paths, {
              ...gatewayEnvironment,
              AGENTOS_MODEL: "openai-codex/model-that-does-not-exist",
            }).pipe(Effect.flip)).message,
            "is not a pinned Pi model",
          );
          assert.isFalse(yield* fileSystem.exists(paths.models));
          assert.isFalse(yield* fileSystem.exists(paths.marker));
        })),
    );
  });
});
