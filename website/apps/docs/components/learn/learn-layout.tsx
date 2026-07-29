import type { ReactNode } from 'react';
import type { TOCItemType } from 'fumadocs-core/toc';
import type { Curriculum, Lesson } from '@/lib/learn/curriculum';
import { LearnDrawer } from './learn-drawer';
import { LearnSidebar } from './learn-sidebar';
import { LessonProgress } from './lesson-progress';

export function LearnLayout({
  curriculum,
  lesson,
  toc,
  children,
}: {
  curriculum: Curriculum;
  lesson: Lesson;
  toc: TOCItemType[];
  children: ReactNode;
}) {
  const lessonIds = curriculum.lessons.map((item) => item.lessonId);

  return (
    <>
      <LearnDrawer
        curriculum={curriculum}
        selection={{ kind: 'lesson', lessonId: lesson.lessonId }}
      />
      <div className="mx-auto grid w-full max-w-[1600px] lg:grid-cols-[290px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)_250px]">
        <LearnSidebar
          curriculum={curriculum}
          selection={{ kind: 'lesson', lessonId: lesson.lessonId }}
        />
        <main className="min-w-0 px-5 py-10 sm:px-8 lg:px-12 xl:px-16">{children}</main>
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto border-l px-6 py-8 xl:block">
          <p className="mb-3 text-xs font-medium tracking-wide text-fd-muted-foreground uppercase">
            On this page
          </p>
          <nav aria-label="On this page" className="mb-7">
            <ul className="space-y-2 text-sm">
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
          <LessonProgress lessonId={lesson.lessonId} validLessonIds={lessonIds} />
          <p className="mt-3 text-xs leading-5 text-fd-muted-foreground">
            Progress stays in this browser. It is not sent anywhere and never gates a chapter.
          </p>
        </aside>
      </div>
    </>
  );
}
