import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

describe('docs lint host boundaries', () => {
  it.effect('keep ambient mutation and raw promises outside AgentOS lint code', () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const scriptsDirectory = yield* paths.fromFileUrl(
        new URL('.', import.meta.url),
      );
      const sources = yield* Effect.forEach(
        ['lint.entry.ts', 'lint.worker.ts', 'lint.ts'],
        (name) => fileSystem.readFileString(paths.join(scriptsDirectory, name)),
      );
      for (const source of sources) {
        for (const forbidden of [
          'process.env',
          'process.exit',
          'async ',
          'new Promise',
          'console.',
        ]) {
          assert.notInclude(source, forbidden);
        }
      }
      assert.include(sources[0], 'ChildProcess.make');
      assert.include(sources[1], 'Effect.tryPromise');
    }).pipe(Effect.provide(BunServices.layer)));
});
