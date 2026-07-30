// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FrameworkProvider } from 'fumadocs-core/framework';
import Layout from '@/app/(home)/layout';

afterEach(() => {
  cleanup();
});

describe('home layout', () => {
  it('anchors the shared header to the viewport edges', () => {
    const { container } = render(
      <FrameworkProvider
        Link={({ href, children, ...props }) => (
          <a href={href} {...props}>
            {children}
          </a>
        )}
        usePathname={() => '/learn'}
        useParams={() => ({})}
        useRouter={() => ({ push: () => {}, refresh: () => {} })}
      >
        <Layout params={Promise.resolve({})}>
          <p>Content</p>
        </Layout>
      </FrameworkProvider>,
    );

    const shell = container.querySelector<HTMLElement>('#nd-home-layout');

    expect(shell?.style.getPropertyValue('--fd-layout-width')).toBe('100vw');
  });

  it('uses one accessible AgentOS wordmark with light and dark variants', () => {
    render(
      <FrameworkProvider
        Link={({ href, children, ...props }) => (
          <a href={href} {...props}>
            {children}
          </a>
        )}
        usePathname={() => '/'}
        useParams={() => ({})}
        useRouter={() => ({ push: () => {}, refresh: () => {} })}
      >
        <Layout params={Promise.resolve({})}>
          <p>Content</p>
        </Layout>
      </FrameworkProvider>,
    );

    const wordmark = screen.getByRole('img', { name: 'AgentOS' });
    const variants = wordmark.querySelectorAll('img[aria-hidden="true"]');

    expect(screen.getAllByRole('img', { name: 'AgentOS' })).toHaveLength(1);
    expect(variants).toHaveLength(2);
    expect(Array.from(variants, (variant) => variant.getAttribute('width'))).toEqual([
      '120',
      '120',
    ]);
  });

  it('puts Learn before the direct Documentation link', () => {
    render(
      <FrameworkProvider
        Link={({ href, children, ...props }) => (
          <a href={href} {...props}>
            {children}
          </a>
        )}
        usePathname={() => '/'}
        useParams={() => ({})}
        useRouter={() => ({ push: () => {}, refresh: () => {} })}
      >
        <Layout params={Promise.resolve({})}>
          <p>Content</p>
        </Layout>
      </FrameworkProvider>,
    );

    const links = screen.getAllByRole('link');
    const learnIndex = links.findIndex((link) => link.textContent === 'Learn');
    const documentationIndex = links.findIndex(
      (link) => link.textContent === 'Documentation',
    );

    expect(learnIndex).toBeGreaterThanOrEqual(0);
    expect(documentationIndex).toBeGreaterThan(learnIndex);
    expect(links[documentationIndex]?.getAttribute('href')).toBe('/docs');
  });
});
