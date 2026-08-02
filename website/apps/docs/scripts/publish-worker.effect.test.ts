import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

import {
  createWranglerProcessArguments,
  runCommandWithTimeoutRetry,
} from './publish-worker';

describe('Worker publication subprocess', () => {
  it('lets Wrangler use its declared Node runtime for provider API calls', () => {
    assert.deepStrictEqual(
      createWranglerProcessArguments(['versions', 'upload']),
      ['x', 'wrangler', 'versions', 'upload'],
    );
  });

  it.live('retries a command whose first attempt never completes', () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'agentos-worker-publish-',
        });
        const attemptPath = paths.join(temporaryDirectory, 'attempts');
        const fixture = [
          'const path = process.argv.at(-1);',
          'let attempt = 0;',
          'try { attempt = Number(await Bun.file(path).text()); } catch {}',
          'attempt += 1;',
          'await Bun.write(path, String(attempt));',
          'if (attempt === 1) setInterval(() => {}, 10_000);',
        ].join('');

        yield* runCommandWithTimeoutRetry(
          'bun',
          ['-e', fixture, attemptPath],
          { attempts: 2, timeoutMs: 500 },
        );
        assert.strictEqual(yield* fileSystem.readFileString(attemptPath), '2');
      }),
    ).pipe(Effect.provide(BunServices.layer)));
});
