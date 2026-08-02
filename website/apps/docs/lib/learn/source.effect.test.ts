import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import { normalizeLearnPage, validateLearnVideo } from './source';

describe('learn source contracts', () => {
  it.effect('maps loader data into a curriculum record', () =>
    Effect.gen(function*() {
      const record = yield* normalizeLearnPage({
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
      });
      assert.deepStrictEqual(record, {
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
    }));

  it.effect('rejects incomplete or insecure video metadata', () =>
    Effect.gen(function*() {
      for (const value of [
        { url: 'http://example.com/video' },
        { url: 'http://example.com/video', title: 'Video' },
      ]) {
        const failure = yield* validateLearnVideo(value).pipe(Effect.flip);
        assert.strictEqual(failure._tag, 'LearnSourceError');
      }
      assert.deepStrictEqual(
        yield* validateLearnVideo({
          url: 'https://example.com/video',
          title: 'Video',
        }),
        { url: 'https://example.com/video', title: 'Video' },
      );
    }));
});
