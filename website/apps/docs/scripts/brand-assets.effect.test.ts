import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

import { generateBrandAssets } from './generate-brand-assets';

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function pngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  assert.deepStrictEqual(Array.from(bytes.subarray(0, 8)), [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  return {
    width: view(bytes).getUint32(16),
    height: view(bytes).getUint32(20),
  };
}

function icoSizes(bytes: Uint8Array): ReadonlyArray<number> {
  const data = view(bytes);
  assert.strictEqual(data.getUint16(0, true), 0);
  assert.strictEqual(data.getUint16(2, true), 1);
  const count = data.getUint16(4, true);
  return Array.from({ length: count }, (_, index) => {
    const width = data.getUint8(6 + index * 16);
    return width === 0 ? 256 : width;
  });
}

describe('AgentOS browser and social assets', () => {
  it.effect('publishes the complete canonical asset contract', () =>
    Effect.gen(function*() {
      yield* generateBrandAssets();
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const appDirectory = yield* paths.fromFileUrl(
        new URL('../app/', import.meta.url),
      );
      const publicDirectory = yield* paths.fromFileUrl(
        new URL('../public/', import.meta.url),
      );

      assert.deepStrictEqual(
        pngDimensions(
          yield* fileSystem.readFile(paths.join(appDirectory, 'icon.png')),
        ),
        { width: 512, height: 512 },
      );
      assert.deepStrictEqual(
        pngDimensions(
          yield* fileSystem.readFile(
            paths.join(appDirectory, 'apple-icon.png'),
          ),
        ),
        { width: 180, height: 180 },
      );
      assert.deepStrictEqual(
        pngDimensions(
          yield* fileSystem.readFile(
            paths.join(publicDirectory, 'opengraph-image.png'),
          ),
        ),
        { width: 1200, height: 630 },
      );
      assert.deepStrictEqual(
        icoSizes(
          yield* fileSystem.readFile(paths.join(appDirectory, 'favicon.ico')),
        ),
        [16, 32, 48],
      );
      assert.isFalse(
        yield* fileSystem.exists(
          paths.join(appDirectory, 'opengraph-image.png'),
        ),
      );
      assert.isFalse(
        yield* fileSystem.exists(paths.join(publicDirectory, 'banner.png')),
      );
    }).pipe(Effect.provide(BunServices.layer)));
});
