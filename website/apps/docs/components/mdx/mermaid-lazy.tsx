'use client';

import dynamic from 'next/dynamic';
import { Effect } from 'effect';
import { loadBrowserModule } from '@/lib/effect/browser-effects';
import { runBrowserPromise } from '@/lib/effect/browser-runtime';

const MermaidRenderer = dynamic(
  () =>
    runBrowserPromise(
      loadBrowserModule('./mermaid', () => import('./mermaid')).pipe(
        Effect.map((module) => module.Mermaid),
      ),
    ),
  { ssr: false },
);

export function Mermaid({ chart }: { chart: string }) {
  return <MermaidRenderer chart={chart} />;
}
