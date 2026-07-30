import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { type ComponentProps, type FC } from 'react';
import * as Twoslash from 'fumadocs-twoslash/ui';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { createMetadata } from '@/lib/metadata';
import { source } from '@/lib/source';
import { Mermaid } from '@/components/mdx/mermaid-lazy';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import Link from 'fumadocs-core/link';
import { findSiblings } from 'fumadocs-core/page-tree';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { getMDXComponents } from '@/components/mdx';
import { Banner } from 'fumadocs-ui/components/banner';
import {
  DocsPage,
  PageLastUpdate,
  MarkdownCopyButton,
  ViewOptionsPopover,
  DocsPageProps,
} from 'fumadocs-ui/layouts/docs/page';
import { PathUtils } from 'fumadocs-core/source';
import { CanonicalSources } from '@/components/canonical-source';

export const revalidate = false;

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);

  if (!page) notFound();

  const pageProps = {
    // tableOfContent: {
    //   footer: <SponsorsMarquee />,
    // },
  } satisfies Partial<DocsPageProps>;

  const { body: Mdx, toc, lastModified } = await page.data.load();

  return (
    <DocsPage toc={toc} {...pageProps}>
      <h1 className="text-[1.75em] font-semibold">{page.data.title}</h1>
      <p className="text-lg text-fd-muted-foreground mb-2">{page.data.description}</p>
      <CanonicalSources sources={page.data.canonical} />
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6 mb-4">
        <MarkdownCopyButton markdownUrl={page.url.replace(/^\/docs/, '/llms.mdx')} />
        <ViewOptionsPopover
          markdownUrl={page.url.replace(/^\/docs/, '/llms.mdx')}
          githubUrl={`https://github.com/akua-dev/agentos/blob/main/website/apps/docs/content/docs/${page.path}`}
        />
      </div>
      <div className="prose flex-1 text-fd-foreground/90">
        <Mdx
          components={getMDXComponents({
            ...Twoslash,
            a({ href, ...props }) {
              const found = source.getPageByHref(href ?? '', {
                dir: PathUtils.dirname(page.path),
              });

              if (!found) return <Link href={href} {...props} />;

              return (
                <HoverCard>
                  <HoverCardTrigger
                    href={found.hash ? `${found.page.url}#${found.hash}` : found.page.url}
                    {...props}
                  >
                    {props.children}
                  </HoverCardTrigger>
                  <HoverCardContent className="text-sm">
                    <p className="font-medium">{found.page.data.title}</p>
                    <p className="text-fd-muted-foreground">{found.page.data.description}</p>
                  </HoverCardContent>
                </HoverCard>
              );
            },
            Banner,
            Mermaid,
            TypeTable,
            blockquote: Callout as unknown as FC<ComponentProps<'blockquote'>>,
            DocsCategory: ({ url }) => {
              return <DocsCategory url={url ?? page.url} />;
            },
          })}
        />
      </div>
      {lastModified && <PageLastUpdate date={lastModified} />}
    </DocsPage>
  );
}

function DocsCategory({ url }: { url: string }) {
  return (
    <Cards>
      {findSiblings(source.getPageTree(), url).map((item) => {
        if (item.type === 'separator') return;
        if (item.type === 'folder') {
          if (!item.index) return;
          item = item.index;
        }

        return (
          <Card key={item.url} title={item.name} href={item.url}>
            {item.description}
          </Card>
        );
      })}
    </Cards>
  );
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const { slug = [] } = await props.params;
  const page = source.getPage(slug);
  if (!page)
    return {
      title: 'Not Found',
      robots: { index: false, follow: false },
    };

  const description = page.data.description ?? 'AgentOS documentation';

  return createMetadata({
    title: page.data.title,
    description,
    path: page.url as `/${string}`,
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
