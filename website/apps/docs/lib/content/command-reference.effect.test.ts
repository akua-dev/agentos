import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Path } from 'effect';

import { bundledCommandReference } from './command-reference.bundled';
import { discoverCommandReference } from './command-reference';

describe('discoverCommandReference', () => {
  it.effect('matches every implemented AgentOS CLI package', () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const clisDirectory = yield* paths.fromFileUrl(
        new URL('../../../../../clis/', import.meta.url),
      );
      const commands = yield* discoverCommandReference(clisDirectory);
      const expected = [
        {
          command: 'github-app-token',
          description:
            'Mint and safely materialize a scoped GitHub App installation token',
          path: 'clis/github-app-token',
        },
        {
          command: 'pg-listen',
          description: 'Wait for one PostgreSQL notification and exit',
          path: 'clis/pg-listen',
        },
      ];

      assert.deepStrictEqual(commands, expected);
      assert.deepStrictEqual(bundledCommandReference, expected);
    }).pipe(Effect.provide(BunServices.layer)));
});
