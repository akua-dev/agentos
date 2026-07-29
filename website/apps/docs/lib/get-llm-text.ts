import type { LearnPage, Page } from '@/lib/source';
import { canonicalSourceUrl } from '@/lib/content/canonical-source';

export async function getLLMText(page: Page | LearnPage) {
  if (!('getText' in page.data)) return '';

  const processed = await page.data.getText('processed');

  const kind = page.url.startsWith('/learn/') ? 'Learn' : 'Docs';
  const category = page.url.split('/')[2] ?? 'Start';
  const canonical = page.data.canonical
    .map(
      (item) => `- ${item.label}: ${canonicalSourceUrl(item.path).toString()}`,
    )
    .join('\n');
  const contentRoot = kind === 'Learn' ? 'content/learn' : 'content/docs';

  return `# ${page.data.title}
Surface: ${kind}
Category: ${category}
URL: ${page.url}
Website source: https://github.com/akua-dev/agentos/blob/main/website/apps/docs/${contentRoot}/${page.path}
${canonical ? `Canonical sources:\n${canonical}` : ''}

${page.data.description ?? ''}

${processed}`;
}
