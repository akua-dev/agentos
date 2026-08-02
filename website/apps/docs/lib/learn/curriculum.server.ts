import { Effect } from 'effect';
import { learnSource } from '@/lib/source';
import { buildCurriculum } from './curriculum';
import { normalizeLearnPage } from './source';

export const getCurriculum = Effect.gen(function*() {
  const records = yield* Effect.forEach(
    learnSource.getPages(),
    (page) =>
      normalizeLearnPage({
        url: page.url,
        data: {
          title: page.data.title,
          description: page.data.description ?? '',
          courseId: page.data.courseId,
          courseTitle: page.data.courseTitle,
          courseOrder: page.data.courseOrder,
          lessonId: page.data.lessonId,
          lessonOrder: page.data.lessonOrder,
          estimatedMinutes: page.data.estimatedMinutes,
        },
      }),
  );
  return yield* buildCurriculum(records);
}).pipe(Effect.withSpan('agentos.website.getCurriculum'));
