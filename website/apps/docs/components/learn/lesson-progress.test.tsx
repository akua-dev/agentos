// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LessonProgress, LearnProgressSummary } from './lesson-progress';
import { learnProgressStorageKey } from '@/lib/learn/progress';

afterEach(() => {
  cleanup();
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('LessonProgress', () => {
  it('hydrates completion and persists a toggle', async () => {
    const storage = memoryStorage({
      [learnProgressStorageKey]: JSON.stringify({
        version: 1,
        completedLessonIds: ['first'],
      }),
    });
    render(
      <LessonProgress lessonId="first" validLessonIds={['first', 'second']} storage={storage} />,
    );

    const button = await screen.findByRole('button', { name: 'Mark incomplete' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(storage.getItem(learnProgressStorageKey) ?? '')).toEqual({
      version: 1,
      completedLessonIds: [],
    });
  });

  it('ignores unknown IDs in the visible count and resets known progress', async () => {
    const storage = memoryStorage({
      [learnProgressStorageKey]: JSON.stringify({
        version: 1,
        completedLessonIds: ['first', 'removed'],
      }),
    });
    render(<LearnProgressSummary validLessonIds={['first', 'second']} storage={storage} />);

    expect(await screen.findByText('1 of 2 complete')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset progress' }));
    await waitFor(() => expect(screen.getByText('0 of 2 complete')).toBeTruthy());
  });

  it('keeps the control usable when storage throws', async () => {
    const storage = {
      ...memoryStorage(),
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };

    render(<LessonProgress lessonId="first" validLessonIds={['first']} storage={storage} />);
    const button = await screen.findByRole('button', { name: 'Mark complete' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
