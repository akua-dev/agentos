import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LearnLayout } from '@/components/learn/learn-layout';
import { LessonHeader } from '@/components/learn/lesson-header';
import { LessonNavigation } from '@/components/learn/lesson-navigation';
import { LessonProgress } from '@/components/learn/lesson-progress';
import { CanonicalSources } from '@/components/canonical-source';
import { getMDXComponents } from '@/components/mdx';
import { getCurriculum } from '@/lib/learn/curriculum.server';
import { findLesson, getLessonNeighbors } from '@/lib/learn/curriculum';
import { learnSource } from '@/lib/source';

export const revalidate = false;

export default async function Page(props: PageProps<'/learn/[...slug]'>) {
  const { slug } = await props.params;
  const page = learnSource.getPage(slug);
  if (!page) notFound();

  const curriculum = getCurriculum();
  const lesson = findLesson(curriculum, page.data.lessonId);
  if (!lesson) notFound();

  const { body: Mdx, toc } = await page.data.load();
  const neighbors = getLessonNeighbors(curriculum, lesson.lessonId);

  return (
    <LearnLayout
      curriculum={curriculum}
      selection={{ kind: 'lesson', lessonId: lesson.lessonId }}
      lesson={lesson}
      toc={toc}
    >
      <article className="mx-auto max-w-[74ch]">
        <LessonHeader lesson={lesson} />
        <details className="mb-8 rounded-xl border p-4 xl:hidden">
          <summary className="cursor-pointer font-medium">Chapter outline</summary>
          <ul className="mt-3 space-y-2 text-sm">
            {toc.map((item) => (
              <li key={item.url}>
                <a href={item.url} className="text-brand hover:underline">
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </details>
        <CanonicalSources sources={page.data.canonical} />
        <div className="prose max-w-none text-fd-foreground/90">
          <Mdx components={getMDXComponents()} />
        </div>
        <div className="mt-8 xl:hidden">
          <LessonProgress
            lessonId={lesson.lessonId}
            validLessonIds={curriculum.lessons.map((item) => item.lessonId)}
          />
        </div>
        <LessonNavigation {...neighbors} />
      </article>
    </LearnLayout>
  );
}

export async function generateMetadata(
  props: PageProps<'/learn/[...slug]'>,
): Promise<Metadata> {
  const { slug } = await props.params;
  const page = learnSource.getPage(slug);
  if (!page) return { title: 'Lesson not found' };
  return {
    title: page.data.title,
    description: page.data.description,
  };
}

export function generateStaticParams() {
  return learnSource.generateParams();
}
