'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';
import { Effect } from 'effect';
import {
  BrowserModuleError,
  loadBrowserModule,
} from '@/lib/effect/browser-effects';
import {
  runBrowserEffect,
  runBrowserSync,
} from '@/lib/effect/browser-runtime';

type MermaidRenderResult = Awaited<
  ReturnType<typeof import('mermaid')['default']['render']>
>;

export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const [rendered, setRendered] = useState<MermaidRenderResult>();

  useEffect(() => {
    return runBrowserEffect(
      Effect.gen(function*() {
        const { default: mermaid } = yield* loadBrowserModule('mermaid', () =>
          import('mermaid'),
        );
        yield* Effect.sync(() =>
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            fontFamily: 'inherit',
            themeCSS: 'margin: 1.5rem auto 0;',
            theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          }),
        );
        const result = yield* Effect.tryPromise({
          try: () => mermaid.render(id, chart.replaceAll('\\n', '\n')),
          catch: (cause) =>
            new BrowserModuleError({
              moduleName: 'mermaid.render',
              message: 'Could not render Mermaid chart',
              cause,
            }),
        });
        yield* Effect.sync(() => setRendered(result));
      }).pipe(Effect.catch(() => Effect.void)),
    );
  }, [chart, id, resolvedTheme]);

  if (rendered === undefined) return;
  return (
    <div
      ref={(container) => {
        if (container === null) return;
        runBrowserSync(
          Effect.sync(() => rendered.bindFunctions?.(container)),
        );
      }}
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  );
}
