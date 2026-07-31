// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FlectWorkplace } from '@/app/(home)/flect-workplace';

afterEach(() => {
  cleanup();
});

describe('FlectWorkplace', () => {
  it('presents Flect as the available human interface for AgentOS', () => {
    render(<FlectWorkplace />);

    expect(
      screen.getByRole('heading', { name: 'One front door to the work of your company.' }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole('img', { name: 'Flect adapting across product interfaces' })
        .getAttribute('src'),
    ).toContain('flect-hero.png');
    expect(screen.getByText('Available today')).not.toBeNull();
    expect(screen.getByText('Flect /flekt/').tagName).toBe('DFN');
    expect(screen.getByText(/from Latin flectere: to bend, curve, or turn/)).not.toBeNull();
    expect(screen.getByText(/Flect makes that idea software/)).not.toBeNull();
    expect(screen.getByText(/running interface bends around the person, task, and decision/)).not.toBeNull();
    expect(screen.getByText(/shape a working UI from inside the product/)).not.toBeNull();
    expect(screen.getByText(/keep or reject it safely/)).not.toBeNull();
    expect(screen.getByText(/dedicated App Agent/)).not.toBeNull();
    expect(screen.getByText(/personalized context and decisions/)).not.toBeNull();
    expect(screen.getByText(/context, expertise, or authority/)).not.toBeNull();
    expect(screen.getByText(/embedded browser or iframe/)).not.toBeNull();
    expect(screen.getByText(/human surface of AgentOS/)).not.toBeNull();
    expect(screen.queryByText(/future direction|future work|not shipped/i)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'See how the workplace works' }).getAttribute('href'),
    ).toBe('/docs/concepts/human-work-surfaces');
    expect(screen.getByRole('link', { name: 'Explore Flect' }).getAttribute('href')).toBe(
      'https://github.com/akua-dev/flect',
    );
    expect(
      screen.getByRole('link', { name: 'Install Flect' }).getAttribute('href'),
    ).toBe('https://github.com/akua-dev/flect#what-works-today');
  });

  it('uses the official hero as the only workflow visual', () => {
    render(<FlectWorkplace />);

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('list', { name: 'Adaptive workplace handoff' })).toBeNull();
    expect(screen.getByText(/AgentOS assembles product work/)).not.toBeNull();
  });
});
