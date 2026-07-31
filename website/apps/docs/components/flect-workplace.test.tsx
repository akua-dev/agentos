// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlectWorkplace } from '@/app/(home)/flect-workplace';

afterEach(() => {
  cleanup();
});

describe('FlectWorkplace', () => {
  it('adapts the decision view while preserving the human approval path', async () => {
    const user = userEvent.setup();
    render(<FlectWorkplace />);

    expect(screen.getByRole('heading', { name: 'Approve the launch scope' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Incident response' }));

    expect(screen.getByRole('heading', { name: 'Choose the recovery path' })).not.toBeNull();
    expect(screen.getByText('Human approval')).not.toBeNull();
    expect(screen.getByText('First Mate')).not.toBeNull();
    expect(screen.getByText('Durable Fleet work')).not.toBeNull();
  });
});
