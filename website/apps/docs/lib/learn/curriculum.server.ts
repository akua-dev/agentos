import { learnSource } from '@/lib/source';
import { buildCurriculum } from './curriculum';
import { normalizeLearnPage } from './source';

export function getCurriculum() {
  return buildCurriculum(
    learnSource.getPages().map((page) =>
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
    ),
  );
}
