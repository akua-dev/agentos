export interface LearningRoute {
  path: `/learn/${string}`;
  title: string;
  lessonId: string;
  course: string;
  position: number;
}

const courses = [
  {
    slug: '01-first-outcome',
    title: 'Run your first outcome',
    lessons: [
      ['bring-agentos-online', 'Bring AgentOS online'],
      ['give-fleet-outcome', 'Give the Fleet a real outcome'],
      ['hand-off-local-work', 'Hand off local work'],
      ['watch-and-steer', 'Watch and steer the work'],
      ['make-human-decision', 'Make the human decision'],
      ['deliver-and-recover', 'Deliver and recover the outcome'],
    ],
  },
  {
    slug: '02-grow-company',
    title: 'Grow the company',
    lessons: [
      ['add-durable-domain', 'Add one durable domain'],
      ['connect-real-world-signals', 'Connect real-world signals'],
      ['teach-company', 'Teach the company'],
      ['measure-and-improve', 'Measure and improve'],
    ],
  },
  {
    slug: '03-stay-in-control',
    title: 'Stay in control',
    lessons: [
      ['upgrade-without-losing-control', 'Upgrade without losing control'],
    ],
  },
] as const;

export const learningRoutes: readonly LearningRoute[] = courses.flatMap((course) =>
  course.lessons.map(([lessonId, title]) => ({
    path: `/learn/${course.slug}/${lessonId}` as `/learn/${string}`,
    title,
    lessonId,
    course: course.title,
    position: 0,
  })),
).map((route, index) => ({ ...route, position: index + 1 }));
