import { ExternalLink } from 'lucide-react';
import {
  canonicalSourceUrl,
  type CanonicalSource,
} from '@/lib/content/canonical-source';

export function CanonicalSources({ sources }: { sources: CanonicalSource[] }) {
  if (sources.length === 0) return null;

  return (
    <aside
      aria-labelledby="canonical-sources-title"
      className="mb-6 rounded-xl border bg-fd-card p-4 text-sm"
    >
      <p id="canonical-sources-title" className="mb-2 font-medium">
        Canonical sources
      </p>
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {sources.map((source) => (
          <li key={`${source.label}:${source.path}`}>
            <a
              href={canonicalSourceUrl(source.path).toString()}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-brand hover:underline"
            >
              {source.label}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
