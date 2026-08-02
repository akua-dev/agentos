import type { FileObject } from 'next-validate-link';
import { scanURLs, validateFiles } from 'next-validate-link';
import { Effect, Runtime, Schema, Stdio, Stream } from 'effect';

import { learnSource, source, type LearnPage, type Page } from '@/lib/source';
import {
  assertValidLinkResults,
  formatLinkValidationResults,
} from './lint-contract';

export class DocsLintError extends Schema.TaggedErrorClass<DocsLintError>()(
  'DocsLintError',
  {
    code: Schema.Literals(['content', 'scan', 'stdio', 'validate']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

function externalPromise<A>(
  code: DocsLintError['code'],
  message: string,
  operation: () => Promise<A>,
) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new DocsLintError({ code, message, cause }),
  });
}

const getHeadings = Effect.fn('agentos.website.getDocsLintHeadings')(
  function*(page: Page | LearnPage) {
    if (page.type !== 'docs') return [];
    const { _exports, toc } = yield* externalPromise(
      'content',
      `Could not load headings for ${page.url}`,
      () => page.data.load(),
    );
    const headings = toc.map((item) => item.url.slice(1));
    const elementIds = _exports?.elementIds;
    return Array.isArray(elementIds)
      ? [...headings, ...elementIds]
      : headings;
  },
);

const pages = Effect.try({
  try: () => ({
    docs: source.getPages(),
    learn: learnSource.getPages(),
  }),
  catch: (cause) =>
    new DocsLintError({
      code: 'content',
      message: 'Could not enumerate AgentOS documentation pages',
      cause,
    }),
});

const getFiles = Effect.fn('agentos.website.getDocsLintFiles')(
  function*(allPages: {
    readonly docs: ReadonlyArray<Page>;
    readonly learn: ReadonlyArray<LearnPage>;
  }) {
    return yield* Effect.forEach(
      [...allPages.docs, ...allPages.learn].filter(
        (page) => page.type === 'docs',
      ),
      (page) =>
        externalPromise(
          'content',
          `Could not load Markdown for ${page.url}`,
          () => page.data.getText('raw'),
        ).pipe(
          Effect.map(
            (content): FileObject => ({
              data: page.data,
              url: page.url,
              path: page.data.info.fullPath,
              content,
            }),
          ),
        ),
      { concurrency: 'unbounded' },
    );
  },
);

const writeLintOutput = Effect.fn('agentos.website.writeDocsLintOutput')(
  function*(value: string) {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(value).pipe(
      Stream.run(stdio.stdout()),
      Effect.mapError(
        (cause) =>
          new DocsLintError({
            code: 'stdio',
            message: 'Could not write the documentation lint report',
            cause,
          }),
      ),
    );
  },
);

export const checkLinks = Effect.gen(function*() {
  const allPages = yield* pages;
  const [docs, learn] = yield* Effect.all(
    [
      Effect.forEach(
        allPages.docs,
        (page) =>
          getHeadings(page).pipe(
            Effect.map((hashes) => ({
              value: { slug: page.slugs },
              hashes,
            })),
          ),
        { concurrency: 'unbounded' },
      ),
      Effect.forEach(
        allPages.learn,
        (page) =>
          getHeadings(page).pipe(
            Effect.map((hashes) => ({
              value: { slug: page.slugs },
              hashes,
            })),
          ),
        { concurrency: 'unbounded' },
      ),
    ],
    { concurrency: 'unbounded' },
  );
  const scanned = yield* externalPromise(
    'scan',
    'Could not scan AgentOS documentation routes',
    () =>
      scanURLs({
        populate: {
          'docs/[[...slug]]': docs,
          '(home)/learn/[...slug]': learn,
        },
      }),
  );
  yield* writeLintOutput(
    `collected ${scanned.urls.size} URLs, ${scanned.fallbackUrls.length} fallbacks\n`,
  );
  const files = yield* getFiles(allPages);
  const results = yield* externalPromise(
    'validate',
    'Could not validate AgentOS documentation links',
    () =>
      validateFiles(files, {
        scanned,
        markdown: {
          components: {
            Card: { attributes: ['href'] },
          },
        },
        checkRelativePaths: 'as-url',
      }),
  );
  yield* writeLintOutput(formatLinkValidationResults(results));
  yield* assertValidLinkResults(results);
}).pipe(Effect.withSpan('agentos.website.checkLinks'));
