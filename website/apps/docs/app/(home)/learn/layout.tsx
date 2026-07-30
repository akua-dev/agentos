import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return <div className="min-h-[calc(100dvh-4rem)]">{children}</div>;
}
