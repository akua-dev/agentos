import type { Metadata } from 'next';
import type { TOCItemType } from 'fumadocs-core/toc';
import { CourseIntroduction } from '@/components/learn/course-introduction';
import { LearnLayout } from '@/components/learn/learn-layout';
import { getCurriculum } from '@/lib/learn/curriculum.server';

export const metadata: Metadata = {
  title: 'What is an autonomous company?',
  description:
    'Begin the AgentOS course with the operating model and outcome of a sovereign autonomous company.',
};

const introductionToc: TOCItemType[] = [
  { title: 'An Agent is not yet a company', url: '#what-makes-it-a-company', depth: 2 },
  { title: 'From one answer to a company', url: '#progression', depth: 2 },
  { title: 'What you will be able to run', url: '#outcome', depth: 2 },
  { title: 'How to use this course', url: '#how-to-use-course', depth: 2 },
];

export default function Page() {
  const curriculum = getCurriculum();
  const firstLesson = curriculum.lessons[0];

  return (
    <LearnLayout
      curriculum={curriculum}
      selection={{ kind: 'introduction' }}
      toc={introductionToc}
    >
      <CourseIntroduction
        firstLessonUrl={
          firstLesson?.url ?? '/learn/01-models-to-agents/what-a-model-does'
        }
      />
    </LearnLayout>
  );
}
