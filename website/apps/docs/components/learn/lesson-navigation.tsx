import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Lesson } from '@/lib/learn/curriculum';

export function LessonNavigation({
  previous,
  next,
}: {
  previous?: Lesson;
  next?: Lesson;
}) {
  return (
    <nav aria-label="Lesson navigation" className="mt-10 grid gap-3 border-t pt-6 sm:grid-cols-2">
      {previous ? (
        <Link
          href={previous.url}
          className="min-h-20 rounded-lg border p-3.5 transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="mb-2 flex items-center gap-1 text-xs text-fd-muted-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> Previous
          </span>
          <span className="font-medium">{previous.title}</span>
        </Link>
      ) : (
        <Link
          href="/learn"
          className="min-h-20 rounded-lg border p-3.5 transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="mb-2 flex items-center gap-1 text-xs text-fd-muted-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> Previous
          </span>
          <span className="font-medium">Introduction</span>
        </Link>
      )}
      {next ? (
        <Link
          href={next.url}
          className="min-h-20 rounded-lg border p-3.5 text-right transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="mb-2 flex items-center justify-end gap-1 text-xs text-fd-muted-foreground">
            Next <ArrowRight className="size-3.5" aria-hidden />
          </span>
          <span className="font-medium">{next.title}</span>
        </Link>
      ) : (
        <Link
          href="/learn"
          className="min-h-20 rounded-lg border p-3.5 text-right transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="mb-2 block text-xs text-fd-muted-foreground">Finished</span>
          <span className="font-medium">Review the course introduction</span>
        </Link>
      )}
    </nav>
  );
}
