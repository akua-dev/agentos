// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FrameworkProvider } from 'fumadocs-core/framework';
import Layout from '@/app/(home)/layout';

afterEach(() => {
  cleanup();
});

describe('home layout', () => {
  it('keeps Documentation as a direct link to the docs root', () => {
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
        <Layout>
          <p>Content</p>
        </Layout>
      </FrameworkProvider>,
    );

    expect(screen.getByRole('link', { name: 'Documentation' }).getAttribute('href')).toBe('/docs');
  });
});
