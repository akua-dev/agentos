import type { TOCItemType } from 'fumadocs-core/toc';
import { Effect } from 'effect';
import { CourseIntroduction } from '@/components/learn/course-introduction';
import { LearnLayout } from '@/components/learn/learn-layout';
import { runServerEffect } from '@/lib/effect/server-runtime';
import { getCurriculum } from '@/lib/learn/curriculum.server';
import { createMetadata } from '@/lib/metadata';

export const metadata = createMetadata({
  title: 'What is an autonomous company?',
  description:
    'Begin the AgentOS course with the operating model and outcome of a sovereign autonomous company.',
  path: '/learn',
});

const introductionToc: TOCItemType[] = [
  { title: 'Get a working Fleet first', url: '#first-win', depth: 2 },
  { title: 'What you will be able to run', url: '#outcome', depth: 2 },
  { title: 'An Agent is not yet a company', url: '#what-makes-it-a-company', depth: 2 },
  { title: 'From one answer to a company', url: '#progression', depth: 2 },
  { title: 'How to use this course', url: '#how-to-use-course', depth: 2 },
];

const renderIntroduction = getCurriculum.pipe(
  Effect.map((curriculum) => {
    const firstLesson = curriculum.lessons[0];
    return (
      <LearnLayout
        curriculum={curriculum}
        selection={{ kind: 'introduction' }}
        toc={introductionToc}
      >
        <CourseIntroduction
          firstLessonUrl={
            firstLesson?.url ?? '/learn/01-first-outcome/bring-agentos-online'
          }
        />
      </LearnLayout>
    );
  }),
);

export default function Page() {
  return runServerEffect(renderIntroduction);
}
