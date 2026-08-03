import { Effect } from 'effect';
import { getLLMText } from '@/lib/get-llm-text';
import { runServerEffect } from '@/lib/effect/server-runtime';
import { learnSource, source } from '@/lib/source';

const renderFullText = Effect.all(
  [...source.getPages(), ...learnSource.getPages()].map(getLLMText),
  { concurrency: 'unbounded' },
).pipe(
  Effect.map((pages) =>
    new Response(pages.join('\n\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  ),
);

export function GET(): Promise<Response> {
  return runServerEffect(renderFullText);
}
