'use client';

import { Check, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  learnProgressStorageKey,
  parseProgress,
  resetProgress,
  toggleLesson,
  type LearnProgress,
} from '@/lib/learn/progress';
import { cn } from '@/lib/cn';

export function useLearnProgress(validLessonIds: readonly string[], storage?: Storage) {
  const [progress, setProgress] = useState<LearnProgress>(resetProgress);

  useEffect(() => {
    try {
      const target = storage ?? window.localStorage;
      setProgress(parseProgress(target.getItem(learnProgressStorageKey)));
    } catch {
      setProgress(resetProgress());
    }
  }, [storage]);

  const validIds = useMemo(() => new Set(validLessonIds), [validLessonIds]);
  const completed = progress.completedLessonIds.filter((id) => validIds.has(id));

  function update(next: LearnProgress) {
    setProgress(next);
    try {
      const target = storage ?? window.localStorage;
      target.setItem(learnProgressStorageKey, JSON.stringify(next));
    } catch {
      // Local progress remains useful in memory when storage is unavailable.
    }
  }

  return { progress, completed, update };
}

export function LessonProgress({
  lessonId,
  validLessonIds,
  storage,
}: {
  lessonId: string;
  validLessonIds: readonly string[];
  storage?: Storage;
}) {
  const { progress, update } = useLearnProgress(validLessonIds, storage);
  const isComplete = progress.completedLessonIds.includes(lessonId);

  return (
    <button
      type="button"
      aria-pressed={isComplete}
      aria-label={isComplete ? 'Mark incomplete' : 'Mark complete'}
      onClick={() => update(toggleLesson(progress, lessonId))}
      className={cn(
        'inline-flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        isComplete
          ? 'border-brand bg-brand text-brand-foreground'
          : 'bg-fd-card hover:bg-fd-accent',
      )}
    >
      <Check className="size-4" aria-hidden />
      {isComplete ? 'Completed' : 'Mark complete'}
    </button>
  );
}

export function LearnProgressSummary({
  validLessonIds,
  storage,
}: {
  validLessonIds: readonly string[];
  storage?: Storage;
}) {
  const { completed, update } = useLearnProgress(validLessonIds, storage);

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <p className="font-medium">
        {completed.length} of {validLessonIds.length} complete
      </p>
      {completed.length > 0 && (
        <button
          type="button"
          aria-label="Reset progress"
          onClick={() => update(resetProgress())}
          className="inline-flex items-center gap-1 text-fd-muted-foreground hover:text-fd-foreground"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Reset
        </button>
      )}
    </div>
  );
}
