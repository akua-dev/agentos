import './global.css';
import { Geist, JetBrains_Mono } from 'next/font/google';
import { createNotFoundMetadata } from '@/lib/metadata';
import NotFound from './not-found';

export const metadata = createNotFoundMetadata();

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
