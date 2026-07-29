import { describe, expect, it } from 'vitest';
import {
  buildCurriculum,
  findLesson,
  getLessonNeighbors,
  type LearnPageRecord,
} from './curriculum';

const pages: LearnPageRecord[] = [
  {
    title: 'Third',
    description: 'third',
    url: '/learn/two/third',
    courseId: 'two',
    courseTitle: 'Course two',
    courseOrder: 2,
    lessonId: 'third',
    lessonOrder: 1,
    estimatedMinutes: 7,
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
  it('sorts courses and lessons with stable global positions and reading time', () => {
    const curriculum = buildCurriculum(pages);
    expect(curriculum.lessons.map((lesson) => [lesson.lessonId, lesson.position])).toEqual([
      ['first', 1],
      ['second', 2],
      ['third', 3],
    ]);
    expect(curriculum.courses.map((course) => [course.id, course.estimatedMinutes])).toEqual([
      ['one', 9],
      ['two', 7],
    ]);
  });

  it('finds lessons and resolves neighbors across a course boundary', () => {
    const curriculum = buildCurriculum(pages);
    expect(findLesson(curriculum, 'second')?.title).toBe('Second');
    expect(getLessonNeighbors(curriculum, 'second')).toMatchObject({
      previous: { lessonId: 'first' },
      next: { lessonId: 'third' },
    });
    expect(findLesson(curriculum, 'missing')).toBeUndefined();
  });

  it.each([
    ['duplicate lesson ID', { ...pages[2], url: '/learn/other', lessonOrder: 3 }],
    ['duplicate URL', { ...pages[2], lessonId: 'other', lessonOrder: 3 }],
    ['duplicate lesson order', { ...pages[2], lessonId: 'other', url: '/learn/other' }],
    [
      'duplicate course order',
      {
        ...pages[2],
        courseId: 'other',
        courseTitle: 'Other',
        lessonId: 'other',
        url: '/learn/other',
      },
    ],
  ])('rejects %s', (_label, duplicate) => {
    expect(() => buildCurriculum([...pages, duplicate as LearnPageRecord])).toThrow();
  });

  it.each([
    ['non-integer order', { ...pages[0], courseOrder: 1.5 }],
    ['zero lesson order', { ...pages[0], lessonOrder: 0 }],
    ['non-positive time', { ...pages[0], estimatedMinutes: -1 }],
  ])('rejects %s', (_label, invalid) => {
    expect(() => buildCurriculum([invalid])).toThrow();
  });
});
