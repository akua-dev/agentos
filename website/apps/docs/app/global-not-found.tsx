import './global.css';
import type { Metadata } from 'next';
import { Geist, JetBrains_Mono } from 'next/font/google';
import NotFound from './not-found';

export const metadata: Metadata = {
  title: 'Not Found',
  alternates: null,
  openGraph: null,
  twitter: null,
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

const geist = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
});

const mono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
});

export default function GlobalNotFound() {
  return (
    <html lang="en" className={`${geist.variable} ${mono.variable}`}>
      <body className="relative flex min-h-screen flex-col">
        <NotFound />
      </body>
    </html>
  );
}
