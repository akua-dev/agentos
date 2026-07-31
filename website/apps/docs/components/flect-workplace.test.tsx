// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FlectWorkplace } from '@/app/(home)/flect-workplace';

afterEach(() => {
  cleanup();
});

describe('FlectWorkplace', () => {
  it('shows the official hero and honest future-direction links', () => {
    render(<FlectWorkplace />);

    expect(
      screen.getByRole('heading', { name: 'One front door to the work of your company.' }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole('img', { name: 'Flect adapting across product interfaces' })
        .getAttribute('src'),
    ).toContain('flect-hero.png');
    expect(screen.getByText('Flect public developer preview')).not.toBeNull();
    expect(screen.getByText(/future direction, not a shipped integration/)).not.toBeNull();
    expect(screen.getByText(/personalized context and decisions/)).not.toBeNull();
    expect(screen.getByText(/standalone\/local interface shell/)).not.toBeNull();
    expect(screen.getByText(/product and API adapters are future work, not shipped/)).not.toBeNull();
    expect(screen.getByText(/adaptable local workplace today/)).not.toBeNull();
    expect(screen.getByText(/context, expertise, or authority/)).not.toBeNull();
    expect(screen.getByText(/embedded browser or iframe/)).not.toBeNull();
    expect(screen.getByText(/future integration path, not a shipped capability/)).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Design a human work surface' }).getAttribute('href'),
    ).toBe('/docs/concepts/human-work-surfaces');
    expect(screen.getByRole('link', { name: 'Explore Flect' }).getAttribute('href')).toBe(
      'https://github.com/akua-dev/flect',
    );
    expect(
      screen.getByRole('link', { name: 'See the current Flect preview' }).getAttribute('href'),
    ).toBe('https://github.com/akua-dev/flect#what-works-today');
  });

  it('uses the official hero as the only workflow visual', () => {
    render(<FlectWorkplace />);

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('list', { name: 'Adaptive workplace handoff' })).toBeNull();
    expect(screen.getByText(/A future AgentOS adapter could assemble/)).not.toBeNull();
  });
});
