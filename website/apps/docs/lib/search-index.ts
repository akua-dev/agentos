import type { AdvancedIndex } from 'fumadocs-core/search/server';
import { Effect, Schema } from 'effect';

type SearchKind = 'Docs' | 'Learn';

export interface SearchIndexPage {
  readonly page: {
    readonly url: string;
    readonly data: {
      readonly title: string;
      readonly description?: string;
      readonly structuredData: () => Promise<AdvancedIndex['structuredData']>;
    };
  };
  readonly kind: SearchKind;
}

export class SearchIndexError extends
  Schema.TaggedErrorClass<SearchIndexError>()('SearchIndexError', {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

export const loadSearchIndexes = Effect.fn('agentos.website.loadSearchIndexes')(
  (pages: ReadonlyArray<SearchIndexPage>) =>
    Effect.forEach(pages, ({ page, kind }) =>
      Effect.tryPromise({
        try: () => page.data.structuredData(),
        catch: (cause) =>
          new SearchIndexError({
            message: `Could not build the search index for ${page.url}`,
            cause,
          }),
      }).pipe(
        Effect.map((structuredData): AdvancedIndex => ({
          title: page.data.title,
          description: page.data.description,
          id: page.url,
          url: page.url,
          tag: kind,
          structuredData,
        })),
      ),
    ),
);
