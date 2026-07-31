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

vi.mock('@/app/(home)/flect-workplace', () => ({
  FlectWorkplace: () => (
    <section>
      <a href="/docs/concepts/human-work-surfaces">See how the workplace works</a>
      <a href="https://github.com/akua-dev/flect">Explore Flect</a>
    </section>
  ),
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

  it('routes local work and adaptive workplaces to their canonical guides', () => {
    render(<Page />);

    expect(
      screen.getByRole('link', { name: 'Hand off local work' }).getAttribute('href'),
    ).toBe('/learn/01-first-outcome/hand-off-local-work');
    expect(
      screen.getByRole('link', { name: 'Use the handoff guide' }).getAttribute('href'),
    ).toBe('/docs/operate/continue-local-work');
    expect(
      screen.getByRole('link', { name: 'See how the workplace works' }).getAttribute('href'),
    ).toBe('/docs/concepts/human-work-surfaces');
    expect(screen.getByRole('link', { name: 'Explore Flect' }).getAttribute('href')).toBe(
      'https://github.com/akua-dev/flect',
    );
  });

  it('presents handoff as a boundary for any product or company work', () => {
    render(<Page />);

    expect(
      screen.getByRole('heading', {
        name: 'Start anywhere. Bring in the Fleet when the outcome matters.',
      }),
    ).not.toBeNull();
    expect(screen.getByText(/UI direction/)).not.toBeNull();
    expect(screen.getByText(/backend architecture/)).not.toBeNull();
    expect(screen.getByText(/code review/)).not.toBeNull();
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
