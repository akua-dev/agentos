import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Effect } from 'effect';
import { runServerEffect } from '@/lib/effect/server-runtime';
import { getLLMText } from '@/lib/get-llm-text';
import { learnSource, source } from '@/lib/source';

const renderPageText = Effect.fn('agentos.website.renderPageText')(
  function*(context: RouteContext<'/llms.mdx/[[...slug]]'>) {
    const { slug } = yield* Effect.promise(() => context.params);
    const page = source.getPage(slug) ?? learnSource.getPage(slug);
    if (page === undefined) return new NextResponse('Not Found', { status: 404 });
    return new NextResponse(yield* getLLMText(page), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    });
  },
);

export function GET(
  _request: NextRequest,
  context: RouteContext<'/llms.mdx/[[...slug]]'>,
): Promise<NextResponse> {
  return runServerEffect(renderPageText(context));
}
