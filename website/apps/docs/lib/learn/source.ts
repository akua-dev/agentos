import { z } from 'zod';
import type { LearnPageRecord } from './curriculum';

const learnVideoSchema = z.object({
  url: z.url().refine((value) => value.startsWith('https://'), 'Video URL must use HTTPS'),
  title: z.string().trim().min(1),
  transcript: z.string().trim().min(1).optional(),
});

export type LearnVideo = z.infer<typeof learnVideoSchema>;

export function validateLearnVideo(value: unknown): LearnVideo {
  return learnVideoSchema.parse(value);
}

export function normalizeLearnPage(page: {
  url: string;
  data: Omit<LearnPageRecord, 'url'>;
}): LearnPageRecord {
  if (!page.url.startsWith('/learn/') || page.url === '/learn/') {
    throw new Error(`Invalid Learn page URL: ${page.url}`);
  }

  return {
    title: page.data.title,
    description: page.data.description,
    url: page.url as `/learn/${string}`,
    courseId: page.data.courseId,
    courseTitle: page.data.courseTitle,
    courseOrder: page.data.courseOrder,
    lessonId: page.data.lessonId,
    lessonOrder: page.data.lessonOrder,
    estimatedMinutes: page.data.estimatedMinutes,
  };
}
