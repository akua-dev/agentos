import { createSearchAPI } from 'fumadocs-core/search/server';
import { learnSource, source } from '@/lib/source';

const search = createSearchAPI('simple', {
  indexes: async () => {
    const pages = [
      ...source.getPages().map((page) => ({ page, kind: 'Docs' })),
      ...learnSource.getPages().map((page) => ({ page, kind: 'Learn' })),
    ];

    return Promise.all(
      pages.map(async ({ page, kind }) => ({
        title: page.data.title,
        description: page.data.description,
        content: await page.data.getText('processed').catch(() => ''),
        url: page.url,
        keywords: kind,
        breadcrumbs: [kind],
      })),
    );
  },
});

export const { GET } = search;
