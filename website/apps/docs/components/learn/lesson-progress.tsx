'use client';

import { Check, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Effect } from 'effect';
import {
  resetProgress,
  toggleLesson,
  type LearnProgress,
} from '@/lib/learn/progress';
import {
  learnProgressStorageLayer,
  loadLearnProgress,
  saveLearnProgress,
} from '@/lib/learn/progress-storage';
import { cn } from '@/lib/cn';
import {
  runBrowserEffect,
  runBrowserSync,
} from '@/lib/effect/browser-runtime';

export function useLearnProgress(validLessonIds: readonly string[], storage?: Storage) {
  const [progress, setProgress] = useState<LearnProgress>(resetProgress);
  const storageLayer = useMemo(() => learnProgressStorageLayer(storage), [storage]);

  useEffect(() => {
    return runBrowserEffect(
      loadLearnProgress.pipe(
        Effect.catch(() => Effect.succeed(resetProgress())),
        Effect.tap((stored) => Effect.sync(() => setProgress(stored))),
        Effect.provide(storageLayer),
      ),
    );
  }, [storageLayer]);

  const validIds = useMemo(() => new Set(validLessonIds), [validLessonIds]);
  const completed = progress.completedLessonIds.filter((id) => validIds.has(id));

  function update(next: LearnProgress) {
    runBrowserSync(
      Effect.sync(() => setProgress(next)).pipe(
        Effect.andThen(saveLearnProgress(next)),
        Effect.catch(() => Effect.void),
        Effect.provide(storageLayer),
      ),
    );
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
