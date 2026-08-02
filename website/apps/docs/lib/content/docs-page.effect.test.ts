import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { loadDocsPage } from './docs-page';

describe('loadDocsPage', () => {
  it.effect('loads a published documentation page through the typed channel', () =>
    Effect.gen(function*() {
      const page = yield* loadDocsPage(
        [],
        () => ({ url: '/docs' }),
        () => Promise.resolve({ body: function Body() {}, toc: [] }),
      );

      assert.strictEqual(page.page.url, '/docs');
      assert.isFunction(page.body);
      assert.isArray(page.toc);
    }));

  it.effect('reports an unknown documentation route as a typed failure', () =>
    Effect.gen(function*() {
      const failure = yield* loadDocsPage(
        ['does-not-exist'],
        () => undefined,
        () => Promise.resolve({}),
      ).pipe(Effect.flip);

      assert.strictEqual(failure._tag, 'DocsPageError');
      assert.strictEqual(failure.code, 'not_found');
    }));
});
