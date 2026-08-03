import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

describe('website browser runtime adapter', () => {
  it.effect('contains only the reviewed React and framework entries', () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const file = yield* paths.fromFileUrl(
        new URL('./browser-runtime.ts', import.meta.url),
      );
      const source = yield* fileSystem.readFileString(file);

      assert.strictEqual(source.match(/Effect\.runCallback/g)?.length, 1);
      assert.strictEqual(source.match(/Effect\.runSync/g)?.length, 1);
      assert.strictEqual(source.match(/Effect\.runPromise/g)?.length, 1);
      assert.notMatch(source, /fetch\(|process\.env|localStorage|setTimeout/);
    }).pipe(Effect.provide(BunServices.layer)));
});
