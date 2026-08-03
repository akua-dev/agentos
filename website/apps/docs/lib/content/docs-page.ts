import { Effect, Schema } from 'effect';

export class DocsPageError extends Schema.TaggedErrorClass<DocsPageError>()(
  'DocsPageError',
  {
    code: Schema.Literals(['not_found', 'load_failed']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const loadDocsPage = Effect.fn('agentos.website.loadDocsPage')(
  function*<Page, Loaded extends object>(
    slug: readonly string[],
    findPage: () => Page | undefined,
    loadPage: (page: Page) => Promise<Loaded>,
  ) {
    const page = findPage();
    if (page === undefined) {
      return yield* new DocsPageError({
        code: 'not_found',
        message: `Documentation page not found: /${slug.join('/')}`,
      });
    }

    const loaded = yield* Effect.tryPromise({
      try: () => loadPage(page),
      catch: (cause) =>
        new DocsPageError({
          code: 'load_failed',
          message: `Could not load documentation page: /${slug.join('/')}`,
          cause,
        }),
    });

    return { page, ...loaded };
  },
);
