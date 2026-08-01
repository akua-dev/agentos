import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Redacted } from "effect";

import { readRedactedFile } from "../src/config.ts";

function fileContaining(value: string) {
  return FileSystem.layerNoop({
    readFileString: () => Effect.succeed(value),
  });
}

describe("OpenFGA secret-file configuration", () => {
  it.effect("preserves an exact newline-free secret", () =>
    Effect.gen(function*() {
      const secret = yield* readRedactedFile("/secret").pipe(
        Effect.provide(fileContaining("exact-secret")),
      );
      assert.strictEqual(Redacted.value(secret), "exact-secret");
    }));

  it.effect("rejects whitespace that would change OpenFGA's environment key", () =>
    Effect.gen(function*() {
      for (const source of ["exact-secret\n", " exact-secret", "exact-secret "]) {
        const failure = yield* readRedactedFile("/secret").pipe(
          Effect.provide(fileContaining(source)),
          Effect.flip,
        );
        assert.strictEqual(failure._tag, "OpenFgaEntrypointError");
        assert.strictEqual(failure.code, "secret_unavailable");
        assert.strictEqual(failure.field, "secret_file");
      }
    }));
});
