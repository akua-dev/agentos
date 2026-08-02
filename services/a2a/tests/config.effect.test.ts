import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError, Redacted, Schema } from "effect";

import { A2aTargetDefinitionV1Schema } from "../src/app.ts";
import {
  readA2aOpenFgaDeployment,
  readA2aSecret,
  readA2aTargetDirectory,
} from "../src/config.ts";

function files(values: Readonly<Record<string, string>>) {
  return FileSystem.layerNoop({
    readFileString: (path) => {
      const value = values[path];
      return value === undefined
        ? Effect.fail(PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: path,
        }))
        : Effect.succeed(value);
    },
  });
}

const target = {
  targetAgentId: "22222222-2222-4222-8222-222222222222",
  targetHandle: "platform-mate",
  description: "Owns the reviewed platform domain",
  agentVersion: "2026.08.02",
  skillVocabulary: [{
    id: "repository.implementation@v1",
    name: "Repository implementation",
    description: "Implements reviewed repository changes",
    tags: ["repository", "implementation"],
  }],
  reviewedSkillIds: ["repository.implementation@v1"],
  profileSkillIds: ["repository.implementation@v1"],
  ceilingSkillIds: ["repository.implementation@v1"],
};

describe("A2A service configuration", () => {
  it.effect("keeps mounted secrets redacted and rejects newline mutation", () =>
    Effect.gen(function*() {
      const secret = yield* readA2aSecret("/database-url").pipe(
        Effect.provide(files({
          "/database-url": "postgresql://a2a:secret@postgres/agentos",
        })),
      );
      assert.strictEqual(
        Redacted.value(secret),
        "postgresql://a2a:secret@postgres/agentos",
      );
      assert.strictEqual(String(secret), "<redacted>");

      const failure = yield* readA2aSecret("/database-url").pipe(
        Effect.provide(files({ "/database-url": "secret\n" })),
        Effect.flip,
      );
      assert.strictEqual(failure.code, "secret_unavailable");
    }));

  it.effect("decodes the pinned OpenFGA deployment and a closed target directory", () =>
    Effect.gen(function*() {
      const targetsJson = yield* Schema.encodeEffect(Schema.fromJsonString(
        Schema.Array(A2aTargetDefinitionV1Schema),
      ))([target]);
      const layer = files({
        "/openfga/store-id": "01J00000000000000000000000\n",
        "/openfga/authorization-model-id":
          "01J00000000000000000000001\n",
        "/targets.json": targetsJson,
      });
      assert.deepStrictEqual(
        yield* readA2aOpenFgaDeployment("/openfga").pipe(
          Effect.provide(layer),
        ),
        {
          storeId: "01J00000000000000000000000",
          authorizationModelId: "01J00000000000000000000001",
        },
      );
      assert.deepStrictEqual(
        yield* readA2aTargetDirectory("/targets.json").pipe(
          Effect.provide(layer),
        ),
        [target],
      );
    }));

  it.effect("allows a fail-closed empty directory and rejects malformed or open entries", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* readA2aTargetDirectory("/targets.json").pipe(
          Effect.provide(files({ "/targets.json": "[]" })),
        ),
        [],
      );
      for (const source of [
        "not-json",
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(
          Schema.Struct({
            ...A2aTargetDefinitionV1Schema.fields,
            unexpected: Schema.Literal(true),
          }),
        )))([{ ...target, unexpected: true }]),
      ]) {
        const failure = yield* readA2aTargetDirectory("/targets.json").pipe(
          Effect.provide(files({ "/targets.json": source })),
          Effect.flip,
        );
        assert.strictEqual(failure.code, "target_directory_unavailable");
      }
    }));
});
