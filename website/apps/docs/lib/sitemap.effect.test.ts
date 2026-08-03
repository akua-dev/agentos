import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { buildSitemap } from './sitemap';

describe('buildSitemap', () => {
  it.effect('renders discovery and content URLs as an absolute sitemap', () =>
    Effect.gen(function*() {
      const sitemap = yield* buildSitemap([
        {
          url: '/docs',
          data: { load: () => Promise.resolve({}) },
        },
      ]);
      const urls = sitemap.map((entry) => entry.url);

      assert.include(urls, 'https://agentos.akua.dev/');
      assert.include(urls, 'https://agentos.akua.dev/learn');
      assert.include(urls, 'https://agentos.akua.dev/docs');
      for (const url of urls) assert.match(url, /^https:\/\/agentos\.akua\.dev\//);
    }));
});
