import { describe, expect, it } from 'vitest';
import { parseProgress, resetProgress, toggleLesson } from './progress';

describe('Learn progress', () => {
  it.each([null, '', 'nope', '{"version":2}', '{"version":1,"completedLessonIds":4}'])(
    'returns empty state for invalid input %j',
    (value) => {
      expect(parseProgress(value)).toEqual({ version: 1, completedLessonIds: [] });
    },
  );

  it('deduplicates IDs and removes non-string values', () => {
    expect(
      parseProgress(
        JSON.stringify({ version: 1, completedLessonIds: ['first', 1, 'first', 'second'] }),
      ),
    ).toEqual({ version: 1, completedLessonIds: ['first', 'second'] });
  });

  it('toggles exactly one stable lesson ID', () => {
    const added = toggleLesson(resetProgress(), 'first');
    expect(added.completedLessonIds).toEqual(['first']);
    expect(toggleLesson(added, 'first')).toEqual(resetProgress());
  });

  it('preserves unknown strings so curriculum consumers can ignore them', () => {
    expect(
      parseProgress(JSON.stringify({ version: 1, completedLessonIds: ['removed-lesson'] })),
    ).toEqual({ version: 1, completedLessonIds: ['removed-lesson'] });
  });
});
