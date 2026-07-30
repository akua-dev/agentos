import { bundledCommandReference } from '@/lib/content/command-reference.bundled';
import { canonicalSourceUrl } from '@/lib/content/canonical-source';

export function CommandReference() {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border">
      {bundledCommandReference.map((item) => (
        <div
          key={item.command}
          className="grid gap-2 border-b p-4 last:border-b-0 sm:grid-cols-[180px_1fr]"
        >
          <a
            href={canonicalSourceUrl(item.path).toString()}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-sm font-medium text-brand hover:underline"
          >
            {item.command}
          </a>
          <p className="text-sm text-fd-muted-foreground">{item.description}</p>
        </div>
      ))}
    </div>
  );
}
