import type { ReactNode } from 'react';
import type { TOCItemType } from 'fumadocs-core/toc';
import type { Curriculum, Lesson } from '@/lib/learn/curriculum';
import { LearnDrawer } from './learn-drawer';
import { LearnSidebar, type LearnSelection } from './learn-sidebar';
import { LearnProgressSummary, LessonProgress } from './lesson-progress';

export function LearnLayout({
  curriculum,
  selection,
  lesson,
  toc,
  children,
}: {
  curriculum: Curriculum;
  selection: LearnSelection;
  lesson?: Lesson;
  toc: TOCItemType[];
  children: ReactNode;
}) {
  const lessonIds = curriculum.lessons.map((item) => item.lessonId);

  return (
    <>
      <LearnDrawer curriculum={curriculum} selection={selection} />
      <div
        className="grid w-full lg:grid-cols-[18.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_minmax(0,1fr)_16rem]"
        style={{ maxWidth: 'none' }}
      >
        <LearnSidebar curriculum={curriculum} selection={selection} />
        <main className="min-w-0 px-5 py-9 sm:px-8 lg:px-10 xl:px-12">{children}</main>
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto border-l px-5 py-6 xl:block">
          <p className="mb-3 text-xs font-medium tracking-wide text-fd-muted-foreground uppercase">
            On this page
          </p>
          <nav aria-label="On this page" className="mb-7">
            <ul className="space-y-1.5 text-[13px] leading-5">
              {toc.map((item) => (
                <li key={item.url}>
                  <a
                    href={item.url}
                    className="text-fd-muted-foreground hover:text-fd-foreground"
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {lesson ? (
            <>
              <LessonProgress lessonId={lesson.lessonId} validLessonIds={lessonIds} />
              <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">
                Progress stays in this browser. It is not sent anywhere and never gates a chapter.
              </p>
            </>
          ) : (
            <>
              <LearnProgressSummary validLessonIds={lessonIds} />
              <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">
                The introduction is unnumbered. Progress counts the {lessonIds.length}{' '}
                {lessonIds.length === 1 ? 'chapter' : 'chapters'}.
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
