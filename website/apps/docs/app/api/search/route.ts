import { createSearchAPI } from 'fumadocs-core/search/server';
import { learnSource, source } from '@/lib/source';

const pages = [
  ...source.getPages().map((page) => ({ page, kind: 'Docs' })),
  ...learnSource.getPages().map((page) => ({ page, kind: 'Learn' })),
];

const search = createSearchAPI('advanced', {
  indexes: async () =>
    Promise.all(
      pages.map(async ({ page, kind }) => ({
        title: page.data.title,
        description: page.data.description,
        id: page.url,
        url: page.url,
        tag: kind,
        structuredData: await page.data.structuredData(),
      })),
    ),
});

export const revalidate = false;
export const { staticGET: GET } = search;
