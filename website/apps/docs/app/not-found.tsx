import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { createNotFoundMetadata } from '@/lib/metadata';

export const metadata = createNotFoundMetadata();

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center px-6 py-24">
      <p className="font-mono text-sm uppercase tracking-[0.18em] text-brand">404 · outside the map</p>
      <h1 className="mt-5 text-balance text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">
        This route does not exist.
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-fd-muted-foreground">
        Return to the company harness, or continue through the public AgentOS documentation.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to AgentOS
        </Link>
        <Link
          href="/docs"
          className="inline-flex items-center gap-2 rounded-full border border-fd-border px-5 py-2.5 text-sm font-medium"
        >
          <BookOpen className="size-4" aria-hidden="true" />
          Read the docs
        </Link>
      </div>
    </main>
  );
}
