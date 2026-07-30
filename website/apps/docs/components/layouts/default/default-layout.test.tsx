// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { FrameworkProvider } from 'fumadocs-core/framework';
import { DefaultLayout } from '.';

vi.mock('@/lib/source', () => ({
  source: {
    getNodeMeta: () => undefined,
    getPageTree: () => ({
      type: 'root',
      name: 'Documentation',
      children: [],
    }),
  },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

describe('documentation layout', () => {
  it('anchors the desktop navigation rails to the viewport edges', () => {
    const { container } = render(
      <FrameworkProvider
        Link={({ href, children, ...props }) => (
          <a href={href} {...props}>
            {children}
          </a>
        )}
        usePathname={() => '/docs'}
        useParams={() => ({})}
        useRouter={() => ({ push: () => {}, refresh: () => {} })}
      >
        <DefaultLayout params={Promise.resolve({})}>
          <p>Documentation</p>
        </DefaultLayout>
      </FrameworkProvider>,
    );

    const shell = container.querySelector<HTMLElement>('#nd-docs-layout');

    expect(shell).not.toBeNull();
    expect(shell?.style.getPropertyValue('--fd-layout-width')).toBe('100vw');
    expect(shell?.style.getPropertyValue('--fd-sidebar-width')).toBe('18.5rem');
    expect(shell?.style.getPropertyValue('--fd-toc-width')).toBe('16rem');
  });
});
