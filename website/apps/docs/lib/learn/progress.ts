export interface LearnProgress {
  version: 1;
  completedLessonIds: string[];
}

export const learnProgressStorageKey = 'agentos.learn.progress.v1';

export function resetProgress(): LearnProgress {
  return { version: 1, completedLessonIds: [] };
}

export function parseProgress(value: string | null): LearnProgress {
  if (!value) return resetProgress();

  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      completedLessonIds?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.completedLessonIds)) {
      return resetProgress();
    }

    return {
      version: 1,
      completedLessonIds: [
        ...new Set(parsed.completedLessonIds.filter((id): id is string => typeof id === 'string')),
      ],
    };
  } catch {
    return resetProgress();
  }
}

export function toggleLesson(progress: LearnProgress, lessonId: string): LearnProgress {
  const completed = new Set(progress.completedLessonIds);
  if (completed.has(lessonId)) completed.delete(lessonId);
  else completed.add(lessonId);
  return { version: 1, completedLessonIds: [...completed] };
}
