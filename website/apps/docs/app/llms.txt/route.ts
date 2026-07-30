import { learnSource, source } from '@/lib/source';
import { renderLlmsIndex } from '@/lib/llms-index';

export const revalidate = false;

export function GET() {
  return new Response(
    renderLlmsIndex({
      documentation: source.getPages(),
      learn: learnSource.getPages(),
    }),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}
