import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions, linkItems, logo } from '@/components/layouts/shared';
import { source } from '@/lib/source';
import { getSection } from '@/lib/source/navigation';
import type { CSSProperties } from 'react';
import 'katex/dist/katex.min.css';

interface AgentOSLayoutStyle extends CSSProperties {
  readonly '--fd-layout-width'?: string;
  readonly '--tab-color'?: string;
}

const layoutStyle: AgentOSLayoutStyle = {
  '--fd-layout-width': '100vw',
};

export function DefaultLayout({ children }: LayoutProps<'/docs'>) {
  const base = baseOptions();

  return (
    <DocsLayout
      {...base}
      tree={source.getPageTree()}
      links={linkItems}
      containerProps={{
        className: 'md:[--fd-sidebar-width:18.5rem]! xl:[--fd-toc-width:16rem]!',
        style: layoutStyle,
      }}
      nav={{
        ...base.nav,
        title: logo,
      }}
      tabs={{
        transform(option, node) {
          const meta = source.getNodeMeta(node);
          if (!meta || !node.icon) return option;
          const color = `var(--${getSection(meta.path)}-color, var(--color-fd-foreground))`;
          const tabStyle: AgentOSLayoutStyle = { '--tab-color': color };

          return {
            ...option,
            icon: (
              <div
                className="[&_svg]:size-full rounded-lg size-full text-(--tab-color) max-md:bg-(--tab-color)/10 max-md:border max-md:p-1.5"
                style={tabStyle}
              >
                {node.icon}
              </div>
            ),
          };
        },
      }}
    >
      {children}
    </DocsLayout>
  );
}
