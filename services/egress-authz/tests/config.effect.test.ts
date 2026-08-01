import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError, Redacted } from "effect";

import {
  readEgressAuthorizerDeployment,
  readEgressAuthorizerSecret,
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

describe("egress authorizer configuration", () => {
  it.effect("loads secrets only from an exact mounted file", () =>
    Effect.gen(function*() {
      const secret = yield* readEgressAuthorizerSecret("/database-url").pipe(
        Effect.provide(files({
          "/database-url": "postgresql://agentos:secret@postgres/agentos",
        })),
      );
      assert.strictEqual(
        Redacted.value(secret),
        "postgresql://agentos:secret@postgres/agentos",
      );
      assert.strictEqual(String(secret), "<redacted>");
    }));

  it.effect("rejects missing, blank, newline-terminated, and oversized secrets", () =>
    Effect.gen(function*() {
      for (const [path, source] of Object.entries({
        "/blank": "",
        "/newline": "secret\n",
        "/oversized": "x".repeat(16 * 1_024 + 1),
      })) {
        const failure = yield* readEgressAuthorizerSecret(path).pipe(
          Effect.provide(files({ [path]: source })),
          Effect.flip,
        );
        assert.strictEqual(failure.code, "secret_unavailable");
      }
      const missing = yield* readEgressAuthorizerSecret("/missing").pipe(
        Effect.provide(files({})),
        Effect.flip,
      );
      assert.strictEqual(missing.code, "secret_unavailable");
    }));

  it.effect("decodes the pinned OpenFGA store and model identifiers", () =>
    Effect.gen(function*() {
      const deployment = yield* readEgressAuthorizerDeployment("/openfga").pipe(
        Effect.provide(files({
          "/openfga/store-id": "01J00000000000000000000000\n",
          "/openfga/authorization-model-id":
            "01J00000000000000000000001\n",
        })),
      );
      assert.deepStrictEqual(deployment, {
        storeId: "01J00000000000000000000000",
        authorizationModelId: "01J00000000000000000000001",
      });
    }));
});
