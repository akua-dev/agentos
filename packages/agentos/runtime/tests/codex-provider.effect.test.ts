import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  reconcileCodexProviderConfigurationEffect,
} from "../codex-provider.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const gatewayEnvironment = {
  AGENTOS_ASSIGNMENT_ID: "20000000-0000-4000-8000-000000000001",
  AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
  AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
  AGENTOS_RELEASE_ROOT: "/opt/agentos",
  AI_GATEWAY_URL:
    "http://agentgateway-openai.agentos.svc.cluster.local:8788/",
  HOME: "/home/agent",
};

const fixture = Effect.fn("test.codexProvider.fixture")(
  function*(initial = "") {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-codex-provider-",
    });
    const codexHome = paths.join(root, "home", ".codex");
    const stateDirectory = paths.join(
      root,
      "home",
      ".local",
      "state",
      "agentos",
    );
    yield* Effect.all([
      fileSystem.makeDirectory(codexHome, { mode: 0o700, recursive: true }),
      fileSystem.makeDirectory(stateDirectory, {
        mode: 0o700,
        recursive: true,
      }),
    ]);
    const configPath = paths.join(codexHome, "config.toml");
    if (initial) {
      yield* fileSystem.writeFileString(configPath, initial, { mode: 0o600 });
    }
    return {
      configPath,
      markerPath: paths.join(stateDirectory, "codex-provider.json"),
      stateDirectory,
    };
  },
);

function reconcile(
  paths: Effect.Success<ReturnType<typeof fixture>>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return reconcileCodexProviderConfigurationEffect({
    configPath: paths.configPath,
    environment,
    stateDirectory: paths.stateDirectory,
  });
}

const runCommand = Effect.fn("test.codexProvider.runCommand")(
  function*(
    executable: string,
    args: ReadonlyArray<string>,
    environment?: Readonly<Record<string, string | undefined>>,
  ) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(executable, args, {
        env: environment === undefined ? undefined : { ...environment },
        extendEnv: true,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode.pipe(Effect.map(Number)),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      ], { concurrency: "unbounded" });
      return { exitCode, stderr, stdout };
    }));
  },
);

describe("Effect Codex workload-authenticated provider", () => {
  layer(platform)((it) => {
    it.effect(
      "owns a command-refreshed Gateway provider without persisting credentials",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture(
            [
              'model = "gpt-5.6-sol"',
              "",
              '[projects."/workspace"]',
              'trust_level = "trusted"',
              "",
            ].join("\n"),
          );

          yield* reconcile(paths, gatewayEnvironment);

          const source = yield* fileSystem.readFileString(paths.configPath);
          assert.include(source, 'model = "gpt-5.6-sol"');
          assert.include(source, 'model_provider = "agentos-gateway"');
          assert.include(source, '[projects."/workspace"]');
          assert.include(source, 'trust_level = "trusted"');
          assert.include(
            source,
            '[model_providers.agentos-gateway.auth]',
          );
          assert.include(
            source,
            'base_url = "http://agentgateway-openai.agentos.svc.cluster.local:8788"',
          );
          assert.include(
            source,
            'command = "/home/agent/.local/share/mise/shims/bun"',
          );
          assert.notInclude(source, "header.payload.signature");
          assert.notInclude(source, "AI_GATEWAY_TOKEN");
          assert.strictEqual(
            (yield* fileSystem.stat(paths.configPath)).mode & 0o777,
            0o600,
          );
          assert.strictEqual(
            (yield* fileSystem.stat(paths.markerPath)).mode & 0o777,
            0o600,
          );

          yield* reconcile(paths, gatewayEnvironment);
          assert.strictEqual(
            yield* fileSystem.readFileString(paths.configPath),
            source,
          );
        })),
    );

    it.effect(
      "restores the prior provider selection during explicit direct rollback",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* fixture(
            [
              'model_provider = "user-provider"',
              "",
              "[model_providers.user-provider]",
              'name = "User provider"',
              'base_url = "https://provider.example/v1"',
              'wire_api = "responses"',
              "",
            ].join("\n"),
          );
          yield* reconcile(paths, gatewayEnvironment);
          yield* reconcile(paths, { AGENTOS_CODEX_PROVIDER_MODE: "direct" });

          const source = yield* fileSystem.readFileString(paths.configPath);
          assert.include(source, 'model_provider = "user-provider"');
          assert.include(source, "[model_providers.user-provider]");
          assert.notInclude(source, "model_providers.agentos-gateway");
          assert.isFalse(yield* fileSystem.exists(paths.markerPath));
        })),
    );

    it.effect(
      "fails closed on ownership collisions and malformed identity inputs",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const collision = yield* fixture(
            [
              "[model_providers.agentos-gateway]",
              'base_url = "https://user.example/v1"',
              "",
            ].join("\n"),
          );
          assert.include(
            (yield* reconcile(collision, gatewayEnvironment).pipe(Effect.flip))
              .message,
            "not owned by AgentOS",
          );

          const malformed = yield* fixture('model = "gpt-5.6-sol"\n');
          assert.include(
            (yield* reconcile(malformed, {
              ...gatewayEnvironment,
              AGENTOS_ASSIGNMENT_ID: "not-an-assignment",
            }).pipe(Effect.flip)).message,
            "AGENTOS_ASSIGNMENT_ID",
          );
          assert.strictEqual(
            yield* fileSystem.readFileString(malformed.configPath),
            'model = "gpt-5.6-sol"\n',
          );
        })),
    );

    it.effect("is accepted by the configured Codex validation binary", () =>
      Effect.scoped(Effect.gen(function*() {
        const validationBin = Option.getOrUndefined(
          yield* Config.option(Config.string("AGENTOS_CODEX_VALIDATION_BIN")),
        );
        if (validationBin === undefined) return;

        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const fixturePaths = yield* fixture('model = "gpt-5.6-sol"\n');
        const codexHome = paths.dirname(fixturePaths.configPath);
        const home = paths.dirname(codexHome);
        const shim = paths.join(
          home,
          ".local",
          "share",
          "mise",
          "shims",
          "bun",
        );
        const tokenFile = paths.join(home, "projected-token");
        const testDirectory = yield* paths.fromFileUrl(
          new URL(".", import.meta.url),
        );
        const releaseRoot = paths.resolve(testDirectory, "../../../..");
        const bunExecutable = (yield* runCommand("which", ["bun"]))
          .stdout.trim();
        assert.isNotEmpty(bunExecutable);
        yield* fileSystem.makeDirectory(paths.dirname(shim), {
          recursive: true,
        });
        yield* fileSystem.symlink(bunExecutable, shim);
        yield* fileSystem.writeFileString(
          tokenFile,
          "header.payload.signature",
          { mode: 0o400 },
        );
        yield* reconcile(fixturePaths, {
          ...gatewayEnvironment,
          AGENTOS_EGRESS_TOKEN_FILE: tokenFile,
          AGENTOS_RELEASE_ROOT: releaseRoot,
          HOME: home,
        });

        const result = yield* runCommand(
          validationBin,
          ["debug", "models"],
          { CODEX_HOME: codexHome },
        );
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.notInclude(result.stderr, "Failed to load");
        assert.notInclude(result.stderr, "config.toml");
      })));
  });
});
