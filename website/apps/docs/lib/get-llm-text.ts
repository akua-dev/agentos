import type { LearnPage, Page } from '@/lib/source';
import { Effect, Schema } from 'effect';
import { canonicalSourceUrl } from '@/lib/content/canonical-source';

export class LlmTextError extends Schema.TaggedErrorClass<LlmTextError>()(
  'LlmTextError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const getLLMText = Effect.fn('agentos.website.getLLMText')(
  function*(page: Page | LearnPage) {
    if (!('getText' in page.data)) return '';
    const processed = yield* Effect.tryPromise({
      try: () => page.data.getText('processed'),
      catch: (cause) =>
        new LlmTextError({
          message: `Could not render language-model text for ${page.url}`,
          cause,
        }),
    });
    const kind = page.url.startsWith('/learn/') ? 'Learn' : 'Docs';
    const category = page.url.split('/')[2] ?? 'Start';
    const canonicalUrls = yield* Effect.forEach(
      page.data.canonical,
      (item) =>
        canonicalSourceUrl(item.path).pipe(
          Effect.map((url) => `- ${item.label}: ${url.toString()}`),
        ),
    );
    const canonical = canonicalUrls.join('\n');
    const contentRoot = kind === 'Learn' ? 'content/learn' : 'content/docs';

    return `# ${page.data.title}
Surface: ${kind}
Category: ${category}
URL: ${page.url}
Website source: https://github.com/akua-dev/agentos/blob/main/website/apps/docs/${contentRoot}/${page.path}
${canonical ? `Canonical sources:\n${canonical}` : ''}

${page.data.description ?? ''}

${processed}`;
  },
);
