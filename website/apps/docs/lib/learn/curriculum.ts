import { Effect, Schema } from 'effect';

export interface LearnPageRecord {
  readonly title: string;
  readonly description: string;
  readonly url: `/learn/${string}`;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly courseOrder: number;
  readonly lessonId: string;
  readonly lessonOrder: number;
  readonly estimatedMinutes: number;
}

export interface Lesson extends LearnPageRecord {
  readonly position: number;
}

export interface Course {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly lessons: readonly Lesson[];
  readonly estimatedMinutes: number;
}

export interface Curriculum {
  readonly version: 1;
  readonly courses: readonly Course[];
  readonly lessons: readonly Lesson[];
}

export class CurriculumError extends Schema.TaggedErrorClass<CurriculumError>()(
  'CurriculumError',
  { message: Schema.String },
) {}

const curriculumError = (message: string) => new CurriculumError({ message });
const isPositiveInteger = (value: number) =>
  Number.isInteger(value) && value > 0;

export const buildCurriculum = Effect.fn('agentos.website.buildCurriculum')(
  function*(records: readonly LearnPageRecord[]) {
    const lessonIds = new Set<string>();
    const urls = new Set<string>();
    const courseDefinitions = new Map<
      string,
      { readonly title: string; readonly order: number }
    >();
    const courseIdsByOrder = new Map<number, string>();
    const lessonOrders = new Map<string, Set<number>>();

    for (const record of records) {
      for (const [label, value] of [
        ['courseOrder', record.courseOrder],
        ['lessonOrder', record.lessonOrder],
        ['estimatedMinutes', record.estimatedMinutes],
      ] satisfies ReadonlyArray<readonly [string, number]>) {
        if (!isPositiveInteger(value)) {
          return yield* curriculumError(`${label} must be a positive integer`);
        }
      }
      if (record.estimatedMinutes > 5) {
        return yield* curriculumError(
          `Chapter must take five minutes or less: ${record.lessonId}`,
        );
      }
      if (!record.url.startsWith('/learn/') || record.url === '/learn/') {
        return yield* curriculumError(`Invalid lesson URL: ${record.url}`);
      }
      if (
        !record.lessonId ||
        !record.courseId ||
        !record.title ||
        !record.courseTitle
      ) {
        return yield* curriculumError(
          'Curriculum identifiers and titles must be non-empty',
        );
      }
      if (lessonIds.has(record.lessonId)) {
        return yield* curriculumError(`Duplicate lesson ID: ${record.lessonId}`);
      }
      if (urls.has(record.url)) {
        return yield* curriculumError(`Duplicate lesson URL: ${record.url}`);
      }
      lessonIds.add(record.lessonId);
      urls.add(record.url);

      const existingCourse = courseDefinitions.get(record.courseId);
      if (
        existingCourse !== undefined &&
        (existingCourse.order !== record.courseOrder ||
          existingCourse.title !== record.courseTitle)
      ) {
        return yield* curriculumError(
          `Inconsistent course definition: ${record.courseId}`,
        );
      }
      const courseAtOrder = courseIdsByOrder.get(record.courseOrder);
      if (courseAtOrder !== undefined && courseAtOrder !== record.courseId) {
        return yield* curriculumError(
          `Duplicate course order: ${record.courseOrder}`,
        );
      }
      courseDefinitions.set(record.courseId, {
        title: record.courseTitle,
        order: record.courseOrder,
      });
      courseIdsByOrder.set(record.courseOrder, record.courseId);

      const orders = lessonOrders.get(record.courseId) ?? new Set<number>();
      if (orders.has(record.lessonOrder)) {
        return yield* curriculumError(
          `Duplicate lesson order in ${record.courseId}: ${record.lessonOrder}`,
        );
      }
      orders.add(record.lessonOrder);
      lessonOrders.set(record.courseId, orders);
    }

    const sorted = [...records].sort(
      (left, right) =>
        left.courseOrder - right.courseOrder ||
        left.lessonOrder - right.lessonOrder,
    );
    const lessons = Object.freeze(
      sorted.map((record, index) =>
        Object.freeze({ ...record, position: index + 1 })
      ),
    );
    const courses = Object.freeze(
      [...courseDefinitions.entries()]
        .sort((left, right) => left[1].order - right[1].order)
        .map(([id, definition]) => {
          const courseLessons = Object.freeze(
            lessons.filter((lesson) => lesson.courseId === id),
          );
          return Object.freeze({
            id,
            title: definition.title,
            order: definition.order,
            lessons: courseLessons,
            estimatedMinutes: courseLessons.reduce(
              (total, lesson) => total + lesson.estimatedMinutes,
              0,
            ),
          });
        }),
    );
    const curriculum: Curriculum = { version: 1, courses, lessons };
    return Object.freeze(curriculum);
  },
);

export function findLesson(
  curriculum: Curriculum,
  lessonId: string,
): Lesson | undefined {
  return curriculum.lessons.find((lesson) => lesson.lessonId === lessonId);
}

export function getLessonNeighbors(
  curriculum: Curriculum,
  lessonId: string,
): { readonly previous?: Lesson; readonly next?: Lesson } {
  const index = curriculum.lessons.findIndex(
    (lesson) => lesson.lessonId === lessonId,
  );
  if (index === -1) return {};
  return {
    previous: curriculum.lessons[index - 1],
    next: curriculum.lessons[index + 1],
  };
}
