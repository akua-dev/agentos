import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions, linkItems } from '@/components/layouts/shared';
import {
  NavbarMenu,
  NavbarMenuContent,
  NavbarMenuLink,
  NavbarMenuTrigger,
} from 'fumadocs-ui/layouts/home/navbar';
import { Book, ComponentIcon, Pencil, PlusIcon, Server } from 'lucide-react';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <HomeLayout
      {...baseOptions()}
      links={[
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
          type: 'custom',
          on: 'nav',
          children: (
            <NavbarMenu>
              <NavbarMenuTrigger>Documentation</NavbarMenuTrigger>
              <NavbarMenuContent>
                <NavbarMenuLink href="/docs/start/get-started" className="md:row-span-2">
                  <div className="-mx-3 -mt-3 mb-4 flex min-h-28 items-center justify-center rounded-t-lg bg-brand/10">
                    <Book className="size-10 text-brand" aria-hidden />
                  </div>
                  <p className="font-medium">Getting Started</p>
                  <p className="text-fd-muted-foreground text-sm">
                    Bring your first AgentOS fleet online.
                  </p>
                </NavbarMenuLink>

                <NavbarMenuLink
                  href="/docs/architecture"
                  className="lg:col-start-2"
                >
                  <ComponentIcon className="bg-fd-primary text-fd-primary-foreground p-1 mb-2 rounded-md" />
                  <p className="font-medium">Architecture</p>
                  <p className="text-fd-muted-foreground text-sm">
                    See every authority and system boundary.
                  </p>
                </NavbarMenuLink>

                <NavbarMenuLink
                  href="/benchmarks"
                  className="lg:col-start-2"
                >
                  <Server className="bg-fd-primary text-fd-primary-foreground p-1 mb-2 rounded-md" />
                  <p className="font-medium">Benchmarks</p>
                  <p className="text-fd-muted-foreground text-sm">
                    Inspect public evidence, including failures.
                  </p>
                </NavbarMenuLink>

                <NavbarMenuLink
                  href="/docs/concepts/autonomous-companies"
                  className="lg:col-start-3 lg:row-start-1"
                >
                  <Pencil className="bg-fd-primary text-fd-primary-foreground p-1 mb-2 rounded-md" />
                  <p className="font-medium">Vision</p>
                  <p className="text-fd-muted-foreground text-sm">
                    Why autonomous companies need an operating system.
                  </p>
                </NavbarMenuLink>

                <NavbarMenuLink
                  href="/docs/contribute"
                  className="lg:col-start-3 lg:row-start-2"
                >
                  <PlusIcon className="bg-fd-primary text-fd-primary-foreground p-1 mb-2 rounded-md" />
                  <p className="font-medium">Contributing</p>
                  <p className="text-fd-muted-foreground text-sm">
                    Help build the open company harness.
                  </p>
                </NavbarMenuLink>
              </NavbarMenuContent>
            </NavbarMenu>
          ),
        },
        ...linkItems,
      ]}
      className="dark:bg-neutral-950 dark:[--color-fd-background:var(--color-neutral-950)] [--color-fd-primary:var(--color-brand)]"
    >
      {children}
    </HomeLayout>
  );
}
