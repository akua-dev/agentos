import { createSearchAPI } from 'fumadocs-core/search/server';
import { runServerEffect } from '@/lib/effect/server-runtime';
import {
  loadSearchIndexes,
  type SearchIndexPage,
} from '@/lib/search-index';
import { learnSource, source, type LearnPage, type Page } from '@/lib/source';

function documentationPage(page: Page): SearchIndexPage {
  return { page, kind: 'Docs' };
}

function learningPage(page: LearnPage): SearchIndexPage {
  return { page, kind: 'Learn' };
}

const pages: ReadonlyArray<SearchIndexPage> = [
  ...source.getPages().map(documentationPage),
  ...learnSource.getPages().map(learningPage),
];

const search = createSearchAPI('advanced', {
  indexes: () => runServerEffect(loadSearchIndexes(pages)),
});

export const revalidate = false;
export const { staticGET: GET } = search;
