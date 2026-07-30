// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreateAppAnimation, Writing } from '@/app/(home)/page.client';

afterEach(() => {
  cleanup();
});

describe('CreateAppAnimation', () => {
  it('renders the bootstrap prompt on two lines without an escaped newline', () => {
    const { container } = render(<CreateAppAnimation />);
    const prompt = container.querySelector('code')?.textContent ?? '';

    expect(prompt).toContain('BOOTSTRAP.md.\nHelp me bring AgentOS online');
    expect(prompt).not.toContain('BOOTSTRAP.md.\\nHelp me bring AgentOS online');
  });
});

describe('Writing', () => {
  it('supports roving keyboard navigation across progression tabs', () => {
    render(
      <Writing
        tabs={{
          chatbot: <p>Chatbot content</p>,
          agent: <p>Agent content</p>,
          company: <p>Company content</p>,
        }}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(document.activeElement).toBe(tabs[1]);
  });
});
