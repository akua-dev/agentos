import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';

import { canonicalSourceUrl } from './canonical-source';

describe('canonicalSourceUrl', () => {
  it.effect('maps repository paths to public URLs', () =>
    Effect.gen(function*() {
      for (const [path, expected] of [
        ['README.md', 'https://github.com/akua-dev/agentos/blob/main/README.md'],
        [
          'packages/agentos/resources/roles/firstmate/skills/agentos-bootstrap/SKILL.md',
          'https://github.com/akua-dev/agentos/blob/main/packages/agentos/resources/roles/firstmate/skills/agentos-bootstrap/SKILL.md',
        ],
        [
          'database/migrations',
          'https://github.com/akua-dev/agentos/tree/main/database/migrations',
        ],
      ]) {
        assert.strictEqual((yield* canonicalSourceUrl(path)).toString(), expected);
      }
    }));

  it.effect('rejects unsafe paths and revisions in the typed channel', () =>
    Effect.gen(function*() {
      for (const path of [
        '',
        '/etc/passwd',
        'https://example.com',
        '../README.md',
        'a/../b',
        'bad\npath',
      ]) {
        const failure = yield* canonicalSourceUrl(path).pipe(Effect.flip);
        assert.strictEqual(failure.code, 'invalid_path');
      }
      const revision = '0123456789abcdef0123456789abcdef01234567';
      assert.strictEqual(
        (yield* canonicalSourceUrl('README.md', revision)).toString(),
        `https://github.com/akua-dev/agentos/blob/${revision}/README.md`,
      );
      for (const invalid of ['abc123', 'g'.repeat(40)]) {
        const failure = yield* canonicalSourceUrl('README.md', invalid).pipe(
          Effect.flip,
        );
        assert.strictEqual(failure.code, 'invalid_revision');
      }
    }));

  it.effect('keeps every published canonical source anchored to the repository', () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const siteRoot = yield* paths.fromFileUrl(new URL('../../', import.meta.url));
      const repositoryRoot = yield* paths.fromFileUrl(
        new URL('../../../../../', import.meta.url),
      );
      const files = yield* fileSystem.glob('content/{docs,learn}/**/*.mdx', {
        root: siteRoot,
      });
      const missing: string[] = [];
      let sourceCount = 0;

      for (const file of files) {
        const content = yield* fileSystem.readFileString(file);
        const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
        for (const match of frontmatter.matchAll(/^\s+path:\s+(.+)$/gm)) {
          const sourcePath = match[1]?.trim();
          if (!sourcePath) continue;
          sourceCount += 1;
          if (!(yield* fileSystem.exists(paths.resolve(repositoryRoot, sourcePath)))) {
            missing.push(`${paths.relative(siteRoot, file)}: ${sourcePath}`);
          }
        }
      }

      assert.isAbove(sourceCount, 100);
      assert.deepStrictEqual(missing, []);
    }).pipe(Effect.provide(BunServices.layer)));
});
