import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { type ComponentProps } from 'react';
import { Effect } from 'effect';
import * as Twoslash from 'fumadocs-twoslash/ui';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { createMetadata, createNotFoundMetadata } from '@/lib/metadata';
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
import { loadDocsPage } from '@/lib/content/docs-page';
import { runServerEffect } from '@/lib/effect/server-runtime';

export const revalidate = false;

function DocsBlockquote(props: ComponentProps<'blockquote'>) {
  return <Callout>{props.children}</Callout>;
}

const renderPage = Effect.fn('agentos.website.renderDocsPage')(
  function*(props: PageProps<'/docs/[[...slug]]'>) {
    const params = yield* Effect.promise(() => props.params);
    const slug = params.slug ?? [];
    const { page, body: Mdx, toc, lastModified } = yield* loadDocsPage(
      slug,
      () => source.getPage(params.slug),
      (found) => found.data.load(),
    );

    const pageProps = {
      // tableOfContent: {
      //   footer: <SponsorsMarquee />,
      // },
    } satisfies Partial<DocsPageProps>;

    return (
      <DocsPage toc={toc} role="main" {...pageProps}>
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
              blockquote: DocsBlockquote,
              DocsCategory: ({ url }) => {
                return <DocsCategory url={url ?? page.url} />;
              },
            })}
          />
        </div>
        {lastModified && <PageLastUpdate date={lastModified} />}
      </DocsPage>
    );
  },
);

export default function Page(props: PageProps<'/docs/[[...slug]]'>) {
  return runServerEffect(
    renderPage(props).pipe(
      Effect.catchTag('DocsPageError', (error) =>
        error.code === 'not_found'
          ? Effect.sync(() => notFound())
          : Effect.fail(error),
      ),
    ),
  );
}

function DocsCategory({ url }: { url: string }) {
  return (
    <>
      <h2 className="sr-only">Explore this section</h2>
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
    </>
  );
}

const renderMetadata = Effect.fn('agentos.website.renderDocsMetadata')(
  function*(props: PageProps<'/docs/[[...slug]]'>): Effect.fn.Return<Metadata> {
    const { slug = [] } = yield* Effect.promise(() => props.params);
    const page = source.getPage(slug);
    if (page === undefined) return createNotFoundMetadata();

    return createMetadata({
      title: page.data.title,
      description: page.data.description ?? 'AgentOS documentation',
      path: page.url,
    });
  },
);

export function generateMetadata(
  props: PageProps<'/docs/[[...slug]]'>,
): Promise<Metadata> {
  return runServerEffect(renderMetadata(props));
}

export function generateStaticParams() {
  return source.generateParams();
}
