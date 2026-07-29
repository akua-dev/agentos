export interface LearnPageRecord {
  title: string;
  description: string;
  url: `/learn/${string}`;
  courseId: string;
  courseTitle: string;
  courseOrder: number;
  lessonId: string;
  lessonOrder: number;
  estimatedMinutes: number;
}

export interface Lesson extends LearnPageRecord {
  position: number;
}

export interface Course {
  id: string;
  title: string;
  order: number;
  lessons: readonly Lesson[];
  estimatedMinutes: number;
}

export interface Curriculum {
  version: 1;
  courses: readonly Course[];
  lessons: readonly Lesson[];
}

function requirePositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function buildCurriculum(records: readonly LearnPageRecord[]): Curriculum {
  const lessonIds = new Set<string>();
  const urls = new Set<string>();
  const courseDefinitions = new Map<string, { title: string; order: number }>();
  const courseIdsByOrder = new Map<number, string>();
  const lessonOrders = new Map<string, Set<number>>();

  for (const record of records) {
    requirePositiveInteger(record.courseOrder, 'courseOrder');
    requirePositiveInteger(record.lessonOrder, 'lessonOrder');
    requirePositiveInteger(record.estimatedMinutes, 'estimatedMinutes');
    if (!record.url.startsWith('/learn/') || record.url === '/learn/') {
      throw new Error(`Invalid lesson URL: ${record.url}`);
    }
    if (!record.lessonId || !record.courseId || !record.title || !record.courseTitle) {
      throw new Error('Curriculum identifiers and titles must be non-empty');
    }
    if (lessonIds.has(record.lessonId)) throw new Error(`Duplicate lesson ID: ${record.lessonId}`);
    if (urls.has(record.url)) throw new Error(`Duplicate lesson URL: ${record.url}`);
    lessonIds.add(record.lessonId);
    urls.add(record.url);

    const existingCourse = courseDefinitions.get(record.courseId);
    if (
      existingCourse &&
      (existingCourse.order !== record.courseOrder || existingCourse.title !== record.courseTitle)
    ) {
      throw new Error(`Inconsistent course definition: ${record.courseId}`);
    }
    const courseAtOrder = courseIdsByOrder.get(record.courseOrder);
    if (courseAtOrder && courseAtOrder !== record.courseId) {
      throw new Error(`Duplicate course order: ${record.courseOrder}`);
    }
    courseDefinitions.set(record.courseId, {
      title: record.courseTitle,
      order: record.courseOrder,
    });
    courseIdsByOrder.set(record.courseOrder, record.courseId);

    const orders = lessonOrders.get(record.courseId) ?? new Set<number>();
    if (orders.has(record.lessonOrder)) {
      throw new Error(`Duplicate lesson order in ${record.courseId}: ${record.lessonOrder}`);
    }
    orders.add(record.lessonOrder);
    lessonOrders.set(record.courseId, orders);
  }

  const sorted = [...records].sort(
    (left, right) =>
      left.courseOrder - right.courseOrder || left.lessonOrder - right.lessonOrder,
  );
  const lessons = Object.freeze(
    sorted.map((record, index) => Object.freeze({ ...record, position: index + 1 })),
  );
  const courses = Object.freeze(
    [...courseDefinitions.entries()]
      .sort((left, right) => left[1].order - right[1].order)
      .map(([id, definition]) => {
        const courseLessons = Object.freeze(lessons.filter((lesson) => lesson.courseId === id));
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

  return Object.freeze({ version: 1 as const, courses, lessons });
}

export function findLesson(curriculum: Curriculum, lessonId: string): Lesson | undefined {
  return curriculum.lessons.find((lesson) => lesson.lessonId === lessonId);
}

export function getLessonNeighbors(
  curriculum: Curriculum,
  lessonId: string,
): { previous?: Lesson; next?: Lesson } {
  const index = curriculum.lessons.findIndex((lesson) => lesson.lessonId === lessonId);
  if (index === -1) return {};
  return {
    previous: curriculum.lessons[index - 1],
    next: curriculum.lessons[index + 1],
  };
}
