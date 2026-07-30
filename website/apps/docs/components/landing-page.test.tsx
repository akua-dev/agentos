// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Page from '@/app/(home)/page';

vi.mock('@/app/(home)/marquee', () => ({
  Marquee: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/app/(home)/page.client', () => ({
  AgnosticBackground: () => null,
  CreateAppAnimation: () => null,
  Hero: () => null,
  Writing: () => null,
}));

afterEach(() => {
  cleanup();
});

describe('landing page', () => {
  it('uses Learn as the primary get-started destination', () => {
    render(<Page />);

    const getStartedLinks = screen.getAllByRole('link', { name: 'Get started' });

    expect(getStartedLinks).toHaveLength(2);
    expect(getStartedLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/learn',
      '/learn',
    ]);
  });

  it('renders the canonical AgentOS structured-data graph', () => {
    const { container } = render(<Page />);
    const script = container.querySelector('script[type="application/ld+json"]');

    expect(script).not.toBeNull();
    expect(JSON.parse(script?.textContent ?? '')).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'AgentOS' },
        {
          '@type': 'SoftwareSourceCode',
          codeRepository: 'https://github.com/akua-dev/agentos',
        },
      ],
    });
  });
});
