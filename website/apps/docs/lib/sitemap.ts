import type { MetadataRoute } from 'next';
import { Effect, Schema } from 'effect';

import { absoluteSiteUrl } from '@/lib/metadata';

export interface SitemapPage {
  readonly url: string;
  readonly data: {
    readonly load: () => Promise<{
      readonly lastModified?: Date | string | number;
    }>;
  };
}

export class SitemapError extends Schema.TaggedErrorClass<SitemapError>()(
  'SitemapError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const buildSitemap = Effect.fn('agentos.website.buildSitemap')(
  (pages: ReadonlyArray<SitemapPage>) => {
    const contentEntries = Effect.forEach(pages, (page) =>
      Effect.tryPromise({
        try: () => page.data.load(),
        catch: (cause) =>
          new SitemapError({
            message: `Could not load sitemap metadata for ${page.url}`,
            cause,
          }),
      }).pipe(
        Effect.map(
          ({ lastModified }): MetadataRoute.Sitemap[number] => ({
            url: absoluteSiteUrl(page.url),
            lastModified: lastModified ? new Date(lastModified) : undefined,
            changeFrequency: 'weekly',
            priority: page.url === '/docs' ? 0.8 : 0.6,
          }),
        ),
      ),
    );

    return contentEntries.pipe(
      Effect.map((content): MetadataRoute.Sitemap => [
        {
          url: absoluteSiteUrl('/'),
          changeFrequency: 'monthly',
          priority: 1,
        },
        {
          url: absoluteSiteUrl('/learn'),
          changeFrequency: 'monthly',
          priority: 0.9,
        },
        {
          url: absoluteSiteUrl('/benchmarks'),
          changeFrequency: 'weekly',
          priority: 0.7,
        },
        ...content,
      ]),
    );
  },
);
