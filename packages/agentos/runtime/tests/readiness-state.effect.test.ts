import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";

import {
  attestPiProviderReadinessEffect,
  CoordinationReadinessState,
  CrewmateReadinessState,
  invalidateCoordinationReadinessEffect,
  PiProviderReadinessState,
  writeCoordinationReadinessEffect,
  writeCrewmateReadinessEffect,
} from "../../src/readiness-state";
import { AgentOSIdentifier } from "../../src/shared/services.ts";

const platform = Layer.merge(BunServices.layer, AgentOSIdentifier.layer);

const readState = Effect.fn("test.readinessState.read")(function*<
  S extends Schema.ConstraintDecoder<unknown>,
>(path: string, schema: S) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    yield* fileSystem.readFileString(path),
  );
});

describe("Effect semantic readiness attestations", () => {
  layer(platform)((it) => {
    it.effect(
      "attests only hashes and selected non-secret Pi configuration",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-readiness-state-",
          });
          const piAgentDirectory = paths.join(root, "pi");
          const stateDirectory = paths.join(root, "state");
          yield* fileSystem.makeDirectory(piAgentDirectory, {
            recursive: true,
          });
          yield* Effect.all([
            fileSystem.writeFileString(
              paths.join(piAgentDirectory, "settings.json"),
              '{"defaultProvider":"openai-codex","defaultModel":"gpt-5.6-sol"}\n',
            ),
            fileSystem.writeFileString(
              paths.join(piAgentDirectory, "models.json"),
              '{"providers":{}}\n',
            ),
          ]);

          yield* attestPiProviderReadinessEffect({
            environment: {
              AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
              AGENTOS_PI_PROVIDER_MODE: "direct",
            },
            piAgentDirectory,
            stateDirectory,
          });

          const path = paths.join(
            stateDirectory,
            "pi-provider-readiness.json",
          );
          const state = yield* readState(path, PiProviderReadinessState);
          assert.deepInclude(state, {
            mode: "direct",
            selectedModel: "openai-codex/gpt-5.6-sol",
            selectedThinking: null,
            version: 1,
          });
          assert.match(state.files.settingsSha256 ?? "", /^[0-9a-f]{64}$/);
          assert.match(state.files.modelsSha256 ?? "", /^[0-9a-f]{64}$/);
          assert.isNull(state.files.markerSha256);
          assert.notInclude(
            yield* fileSystem.readFileString(path),
            "token",
          );
          assert.strictEqual(
            (yield* fileSystem.stat(path)).mode & 0o777,
            0o600,
          );
        })),
    );

    it.effect(
      "tracks listener registration, catch-up, and terminal invalidation",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-readiness-state-",
          });
          const options = {
            agentName: "firstmate",
            herdrSession: "agentos-firstmate",
            listenerProcessId: 9001,
            listenerTaskId: "bg-listener",
            ownerProcessId: 4242,
            stateDirectory: root,
          };

          yield* writeCoordinationReadinessEffect({
            ...options,
            phase: "listening",
          });
          const path = paths.join(root, "readiness", "coordination.json");
          assert.deepInclude(
            yield* readState(path, CoordinationReadinessState),
            {
              listenerTaskId: "bg-listener",
              listenerProcessId: 9001,
              ownerProcessId: 4242,
              phase: "listening",
              version: 1,
            },
          );

          yield* writeCoordinationReadinessEffect({
            ...options,
            phase: "caught_up",
          });
          assert.strictEqual(
            (yield* readState(path, CoordinationReadinessState)).phase,
            "caught_up",
          );

          yield* invalidateCoordinationReadinessEffect(root, "another-task");
          assert.isTrue(yield* fileSystem.exists(path));
          yield* invalidateCoordinationReadinessEffect(root, "bg-listener");
          assert.isFalse(yield* fileSystem.exists(path));
        })),
    );

    it.effect(
      "writes an identity-bound Crewmate launch confirmation",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-readiness-state-",
          });
          const expected = {
            agentId: "00000000-0000-4000-8000-000000000003",
            assignmentId: "00000000-0000-4000-8000-000000000005",
            briefSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            harness: "codex",
            herdrSession: "agentos-crewmate",
            processId: 4242,
            taskId: "00000000-0000-4000-8000-000000000004",
            version: 1,
          };
          yield* writeCrewmateReadinessEffect({
            ...expected,
            stateDirectory: root,
          });

          const path = paths.join(root, "readiness", "crewmate.json");
          assert.deepStrictEqual(
            yield* readState(path, CrewmateReadinessState),
            expected,
          );
          assert.strictEqual(
            (yield* fileSystem.stat(path)).mode & 0o777,
            0o600,
          );
        })),
    );
  });
});
