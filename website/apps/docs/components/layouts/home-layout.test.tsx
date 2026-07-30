// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FrameworkProvider } from 'fumadocs-core/framework';
import Layout from '@/app/(home)/layout';

afterEach(() => {
  cleanup();
});

describe('home layout', () => {
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
