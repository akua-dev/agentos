import { HomeLayout } from 'fumadocs-ui/layouts/home';
import {
  baseOptions,
  learnLinkItem,
  secondaryLinkItems,
} from '@/components/layouts/shared';
import { Book, ComponentIcon } from 'lucide-react';
import type { CSSProperties } from 'react';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <HomeLayout
      {...baseOptions()}
      links={[
        learnLinkItem,
        {
          type: 'menu',
          on: 'menu',
          text: 'Documentation',
          items: [
            {
              text: 'Getting Started',
              url: '/docs/start/get-started',
              icon: <Book />,
            },
            {
              text: 'Architecture',
              url: '/docs/architecture',
              icon: <ComponentIcon />,
            },
          ],
        },
        {
          text: 'Documentation',
          url: '/docs',
          on: 'nav',
          active: 'nested-url',
        },
        ...secondaryLinkItems,
      ]}
      className="dark:bg-neutral-950 dark:[--color-fd-background:var(--color-neutral-950)] [--color-fd-primary:var(--color-brand)]"
      style={
        {
          '--fd-layout-width': '100vw',
        } as CSSProperties
      }
    >
      {children}
    </HomeLayout>
  );
}
