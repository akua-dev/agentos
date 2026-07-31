// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FlectWorkplace } from '@/app/(home)/flect-workplace';

afterEach(() => {
  cleanup();
});

describe('FlectWorkplace', () => {
  it('shows the official hero and honest future-direction links', () => {
    render(<FlectWorkplace />);

    expect(
      screen.getByRole('heading', { name: 'The interface to your AgentOS company.' }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole('img', { name: 'Flect adapting across product interfaces' })
        .getAttribute('src'),
    ).toContain('flect-hero.png');
    expect(screen.getByText('Flect public developer preview')).not.toBeNull();
    expect(screen.getByText(/future direction, not a shipped integration/)).not.toBeNull();
    expect(screen.getByText(/personalized context and decisions/)).not.toBeNull();
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

  it('shows an accessible animated handoff sequence', () => {
    render(<FlectWorkplace />);

    const sequence = screen.getByRole('list', { name: 'Adaptive workplace handoff' });
    const steps = within(sequence).getAllByRole('listitem');

    expect(sequence.getAttribute('data-animation')).toBe('flect-handoff');
    expect(steps).toHaveLength(4);
    expect(sequence.textContent).toContain('Personalized decisions');
    expect(sequence.textContent).toContain('Agent-assisted revision');
    expect(sequence.textContent).toContain('Human approval');
    expect(sequence.textContent).toContain('Handoff to First Mate');
  });
});
