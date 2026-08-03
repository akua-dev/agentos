import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { loadSearchIndexes } from './search-index';

describe('loadSearchIndexes', () => {
  it.effect('loads docs and learning pages into the advanced search contract', () =>
    Effect.gen(function*() {
      const structuredData = { headings: [], contents: [] };
      const indexes = yield* loadSearchIndexes([
        {
          kind: 'Docs',
          page: {
            url: '/docs',
            data: {
              title: 'Docs',
              structuredData: () => Promise.resolve(structuredData),
            },
          },
        },
        {
          kind: 'Learn',
          page: {
            url: '/learn/lesson',
            data: {
              title: 'Lesson',
              structuredData: () => Promise.resolve(structuredData),
            },
          },
        },
      ]);

      assert.lengthOf(indexes, 2);
      assert.isTrue(indexes.some((index) => index.tag === 'Docs'));
      assert.isTrue(indexes.some((index) => index.tag === 'Learn'));
      for (const index of indexes) {
        assert.strictEqual(index.id, index.url);
        assert.match(index.url, /^\/(docs|learn)/);
        assert.isObject(index.structuredData);
      }
    }));
});
