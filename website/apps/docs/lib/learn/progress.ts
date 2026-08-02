import { Option, Schema } from 'effect';

export interface LearnProgress {
  version: 1;
  completedLessonIds: string[];
}

export const learnProgressStorageKey = 'agentos.learn.progress.v1';

const LearnProgressInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  completedLessonIds: Schema.Array(Schema.Unknown),
});
const LearnProgressInputFromString = Schema.fromJsonString(
  LearnProgressInputSchema,
);

export function resetProgress(): LearnProgress {
  return { version: 1, completedLessonIds: [] };
}

export function parseProgress(value: string | null): LearnProgress {
  if (!value) return resetProgress();
  const decoded = Schema.decodeUnknownOption(LearnProgressInputFromString)(
    value,
  );
  if (Option.isNone(decoded)) return resetProgress();
  return {
    version: 1,
    completedLessonIds: [
      ...new Set(
        decoded.value.completedLessonIds.filter(
          (id): id is string => typeof id === 'string',
        ),
      ),
    ],
  };
}

export function toggleLesson(progress: LearnProgress, lessonId: string): LearnProgress {
  const completed = new Set(progress.completedLessonIds);
  if (completed.has(lessonId)) completed.delete(lessonId);
  else completed.add(lessonId);
  return { version: 1, completedLessonIds: [...completed] };
}
