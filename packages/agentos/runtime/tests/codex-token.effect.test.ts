import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { readCodexWorkloadToken } from "../codex-token.ts";

describe("Effect Codex workload credential helper", () => {
  layer(BunServices.layer)((it) => {
    it.effect(
      "reads each rotation and rejects malformed, oversized, invalid UTF-8, or unavailable input",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-codex-token-",
          });
          const path = paths.join(directory, "token");
          yield* fileSystem.writeFileString(
            path,
            "header.first.signature",
            { mode: 0o440 },
          );
          assert.strictEqual(
            yield* readCodexWorkloadToken(path),
            "header.first.signature",
          );

          yield* fileSystem.chmod(path, 0o640);
          yield* fileSystem.writeFileString(path, "header.rotated.signature");
          assert.strictEqual(
            yield* readCodexWorkloadToken(path),
            "header.rotated.signature",
          );

          yield* fileSystem.writeFileString(path, " malformed ");
          assert.strictEqual(
            (yield* readCodexWorkloadToken(path).pipe(Effect.flip)).message,
            "projected workload token is invalid",
          );

          yield* fileSystem.writeFileString(
            path,
            `a.${"b".repeat(16 * 1024)}.c`,
          );
          assert.strictEqual(
            (yield* readCodexWorkloadToken(path).pipe(Effect.flip)).message,
            "projected workload token is invalid",
          );

          yield* fileSystem.writeFile(path, new Uint8Array([0xff]));
          assert.strictEqual(
            (yield* readCodexWorkloadToken(path).pipe(Effect.flip)).message,
            "projected workload token is invalid",
          );

          assert.strictEqual(
            (yield* readCodexWorkloadToken(
              paths.join(directory, "missing"),
            ).pipe(Effect.flip)).message,
            "projected workload token is unavailable",
          );
        })),
    );
  });
});
