import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
  buildCurriculum,
  findLesson,
  getLessonNeighbors,
  type LearnPageRecord,
} from './curriculum';

const pages: readonly [LearnPageRecord, LearnPageRecord, LearnPageRecord] = [
  {
    title: 'Third',
    description: 'third',
    url: '/learn/two/third',
    courseId: 'two',
    courseTitle: 'Course two',
    courseOrder: 2,
    lessonId: 'third',
    lessonOrder: 1,
    estimatedMinutes: 5,
  },
  {
    title: 'Second',
    description: 'second',
    url: '/learn/one/second',
    courseId: 'one',
    courseTitle: 'Course one',
    courseOrder: 1,
    lessonId: 'second',
    lessonOrder: 2,
    estimatedMinutes: 5,
  },
  {
    title: 'First',
    description: 'first',
    url: '/learn/one/first',
    courseId: 'one',
    courseTitle: 'Course one',
    courseOrder: 1,
    lessonId: 'first',
    lessonOrder: 1,
    estimatedMinutes: 4,
  },
];

describe('buildCurriculum', () => {
  it.effect('sorts courses and lessons with stable positions and reading time', () =>
    Effect.gen(function*() {
      const curriculum = yield* buildCurriculum(pages);
      assert.deepStrictEqual(
        curriculum.lessons.map((lesson) => [lesson.lessonId, lesson.position]),
        [['first', 1], ['second', 2], ['third', 3]],
      );
      assert.deepStrictEqual(
        curriculum.courses.map((course) => [course.id, course.estimatedMinutes]),
        [['one', 9], ['two', 5]],
      );
    }));

  it.effect('finds lessons and resolves neighbors across a course boundary', () =>
    Effect.gen(function*() {
      const curriculum = yield* buildCurriculum(pages);
      assert.strictEqual(findLesson(curriculum, 'second')?.title, 'Second');
      const neighbors = getLessonNeighbors(curriculum, 'second');
      assert.strictEqual(neighbors.previous?.lessonId, 'first');
      assert.strictEqual(neighbors.next?.lessonId, 'third');
      assert.strictEqual(findLesson(curriculum, 'missing'), undefined);
    }));

  it.effect('rejects duplicate identity, URLs, and ordering', () =>
    Effect.gen(function*() {
      const duplicates: ReadonlyArray<LearnPageRecord> = [
        { ...pages[2], url: '/learn/other', lessonOrder: 3 },
        { ...pages[2], lessonId: 'other', lessonOrder: 3 },
        { ...pages[2], lessonId: 'other', url: '/learn/other' },
        {
          ...pages[2],
          courseId: 'other',
          courseTitle: 'Other',
          lessonId: 'other',
          url: '/learn/other',
        },
      ];
      for (const duplicate of duplicates) {
        const failure = yield* buildCurriculum([...pages, duplicate]).pipe(
          Effect.flip,
        );
        assert.strictEqual(failure._tag, 'CurriculumError');
      }
    }));

  it.effect('rejects invalid order and chapter duration', () =>
    Effect.gen(function*() {
      const invalid: ReadonlyArray<LearnPageRecord> = [
        { ...pages[0], courseOrder: 1.5 },
        { ...pages[0], lessonOrder: 0 },
        { ...pages[0], estimatedMinutes: -1 },
        { ...pages[0], estimatedMinutes: 6 },
      ];
      for (const record of invalid) {
        const failure = yield* buildCurriculum([record]).pipe(Effect.flip);
        assert.strictEqual(failure._tag, 'CurriculumError');
      }
    }));
});
