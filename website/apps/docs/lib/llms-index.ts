import { absoluteSiteUrl, defaultDescription } from './metadata';

interface LlmsIndexPage {
  url: string;
  data: {
    title: string;
    description?: string;
  };
}

interface LlmsIndexInput {
  documentation: readonly LlmsIndexPage[];
  learn: readonly LlmsIndexPage[];
}

function section(title: string, pages: readonly LlmsIndexPage[]): string {
  return [
    `## ${title}`,
    ...pages.map(
      (page) =>
        `- [${page.data.title}](${absoluteSiteUrl(page.url as `/${string}`)}): ${
          page.data.description ?? ''
        }`,
    ),
  ].join('\n');
}

export function renderLlmsIndex({
  documentation,
  learn,
}: LlmsIndexInput): string {
  return [
    '# AgentOS',
    '',
    `> ${defaultDescription}`,
    '',
    '## For language models',
    `- [Full AgentOS text](${absoluteSiteUrl('/llms-full.txt')}): Consolidated documentation and learning content.`,
    '',
    section('Documentation', documentation),
    '',
    section('Learn', learn),
    '',
    '## Evidence',
    `- [Benchmarks](${absoluteSiteUrl('/benchmarks')}): Public AgentOS outcomes, failures and recovery evidence.`,
  ].join('\n');
}
