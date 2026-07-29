import { learnSource, source } from '@/lib/source';

export const revalidate = false;

export function GET() {
  const section = (
    title: string,
    pages: Array<{ url: string; data: { title: string; description?: string } }>,
  ) =>
    [
      `## ${title}`,
      ...pages.map(
        (page) =>
          `- [${page.data.title}](${page.url}): ${page.data.description ?? ''}`,
      ),
    ].join('\n');

  return new Response(
    [
      '# AgentOS',
      '',
      '> The open-source company harness. Build autonomous companies under human control.',
      '',
      section('Documentation', source.getPages()),
      '',
      section('Learn', learnSource.getPages()),
      '',
      '## Evidence',
      '- [Benchmarks](/benchmarks): Public AgentOS outcomes, failures and recovery evidence.',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}
