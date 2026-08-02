import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

describe('website script runtime adapter', () => {
  it.effect('contains one reviewed Bun entry for every website script', () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const file = yield* paths.fromFileUrl(
        new URL('./script-runtime.ts', import.meta.url),
      );
      const source = yield* fileSystem.readFileString(file);

      assert.strictEqual(source.match(/BunRuntime\.runMain/g)?.length, 1);
      assert.include(source, 'BunHttpClient.layer');
      assert.notMatch(source, /process\.|Bun\.env|fetch\(|node:fs|node:child_process/);
    }).pipe(Effect.provide(BunServices.layer)));
});
