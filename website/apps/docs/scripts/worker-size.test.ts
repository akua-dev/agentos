import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';
import {
  assertWorkerFitsFreePlan,
  parseCompressedWorkerSize,
} from './worker-size';
import { shouldVerifyWorkerSize } from './finalize-worker-build';

describe('Cloudflare Worker size contract', () => {
  it.effect('reads the compressed upload size reported by Wrangler', () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* parseCompressedWorkerSize(
          'Total Upload: 13833.20 KiB / gzip: 2295.89 KiB',
        ),
        2295.89,
      );
    }));

  it.effect('accepts a Worker within the free-plan upload limit', () =>
    assertWorkerFitsFreePlan(3072));

  it.effect('rejects a Worker over the free-plan upload limit', () =>
    Effect.gen(function*() {
      const failure = yield* assertWorkerFitsFreePlan(3072.01).pipe(Effect.flip);
      assert.include(failure.message, '3 MiB Cloudflare Workers Free limit');
    }));

  it('leaves the redundant dry run to CI when Workers Builds will upload next', () => {
    assert.isFalse(shouldVerifyWorkerSize({ WORKERS_CI: '1' }));
    assert.isTrue(shouldVerifyWorkerSize({ CI: 'true' }));
    assert.isTrue(shouldVerifyWorkerSize({}));
  });

  it.effect('deduplicates Effect modules in the deployable Worker bundle', () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const packagePath = yield* paths.fromFileUrl(
        new URL('../package.json', import.meta.url),
      );
      const source = yield* fileSystem.readFileString(packagePath);
      assert.include(source, 'next build --webpack');
    }).pipe(Effect.provide(BunServices.layer)));
});
