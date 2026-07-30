'use client';

import dynamic from 'next/dynamic';

const MermaidRenderer = dynamic(
  () => import('./mermaid').then((module) => module.Mermaid),
  { ssr: false },
);

export function Mermaid({ chart }: { chart: string }) {
  return <MermaidRenderer chart={chart} />;
}
