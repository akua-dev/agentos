import { describe, expect, it } from 'vitest';
import { normalizeLearnPage, validateLearnVideo } from './source';

describe('normalizeLearnPage', () => {
  it('maps loader data into a curriculum record', () => {
    expect(
      normalizeLearnPage({
        url: '/learn/01-models/what-a-model-does',
        data: {
          title: 'What a model does',
          description: 'Generation without ownership.',
          courseId: 'models',
          courseTitle: 'From models to Agents',
          courseOrder: 1,
          lessonId: 'what-a-model-does',
          lessonOrder: 1,
          estimatedMinutes: 6,
        },
      }),
    ).toEqual({
      title: 'What a model does',
      description: 'Generation without ownership.',
      url: '/learn/01-models/what-a-model-does',
      courseId: 'models',
      courseTitle: 'From models to Agents',
      courseOrder: 1,
      lessonId: 'what-a-model-does',
      lessonOrder: 1,
      estimatedMinutes: 6,
    });
  });

  it('rejects incomplete or insecure video metadata', () => {
    expect(() => validateLearnVideo({ url: 'http://example.com/video' })).toThrow();
    expect(() =>
      validateLearnVideo({ url: 'http://example.com/video', title: 'Video' }),
    ).toThrow();
    expect(validateLearnVideo({ url: 'https://example.com/video', title: 'Video' })).toEqual({
      url: 'https://example.com/video',
      title: 'Video',
    });
  });
});
