'use client';

import { RootProvider } from 'fumadocs-ui/provider/base';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { loadBrowserModule } from '@/lib/effect/browser-effects';
import { runBrowserPromise } from '@/lib/effect/browser-runtime';

const SearchDialog = dynamic(
  () =>
    runBrowserPromise(
      loadBrowserModule('@/components/layouts/search', () =>
        import('@/components/layouts/search'),
      ),
    ),
  { ssr: false },
);

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        SearchDialog,
      }}
    >
      <Tooltip.Provider>
        {children}
      </Tooltip.Provider>
    </RootProvider>
  );
}
