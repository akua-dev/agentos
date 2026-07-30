import './global.css';
import type { Viewport } from 'next';
import { baseUrl, createMetadata } from '@/lib/metadata';
import { Body } from '@/app/layout.client';
import { Provider } from './provider';
import type { ReactNode } from 'react';
import { Geist, JetBrains_Mono } from 'next/font/google';
import { TreeContextProvider } from 'fumadocs-ui/contexts/tree';
import { source } from '@/lib/source';
import { NextProvider } from 'fumadocs-core/framework/next';

export const metadata = createMetadata({
  title: {
    template: '%s | AgentOS',
    default: 'AgentOS',
  },
  description: 'The open-source company harness.',
  metadataBase: baseUrl,
});

const geist = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
});

const mono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
});

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0A0A0A' },
    { media: '(prefers-color-scheme: light)', color: '#fff' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/*
          OpenNext's Worker bundle currently serializes next-themes with esbuild's
          function-name helper call but not the helper definition. Define the
          standard helper before next-themes runs so the first paint can select
          the saved/system theme without a browser exception.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'globalThis.__name=globalThis.__name||function(target,value){return Object.defineProperty(target,"name",{value:value,configurable:true})};',
          }}
        />
      </head>
      <Body>
        <NextProvider>
          <TreeContextProvider tree={source.getPageTree()}>
            <Provider>{children}</Provider>
          </TreeContextProvider>
        </NextProvider>
      </Body>
    </html>
  );
}
