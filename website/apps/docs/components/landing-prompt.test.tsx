// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CreateAppAnimation } from '@/app/(home)/page.client';

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
