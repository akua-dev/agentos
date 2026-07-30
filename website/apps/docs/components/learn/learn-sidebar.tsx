import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Curriculum } from '@/lib/learn/curriculum';

export type LearnSelection =
  | { kind: 'introduction' }
  | { kind: 'lesson'; lessonId: string };

export function CurriculumNavigation({
  curriculum,
  selection,
  onNavigate,
}: {
  curriculum: Curriculum;
  selection: LearnSelection;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Learn curriculum">
      <Link
        href="/learn"
        onClick={onNavigate}
        aria-current={selection.kind === 'introduction' ? 'page' : undefined}
        className={cn(
          'mb-3.5 grid h-7 grid-cols-[20px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-[13px] leading-4 transition-colors',
          selection.kind === 'introduction'
            ? 'bg-brand/12 font-medium text-brand'
            : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground',
        )}
      >
        <span
          className="flex size-5 items-center justify-center rounded-[4px] border border-current/20"
          aria-hidden
        >
          <BookOpen className="size-3" />
        </span>
        <span className="truncate">Introduction</span>
      </Link>
      {curriculum.courses.map((course) => (
        <section key={course.id} className="mb-3.5 last:mb-0">
          <h2 className="mb-1 px-2 text-[11px] leading-5 font-medium tracking-[0.04em] text-fd-muted-foreground uppercase">
            {course.order}. {course.title}
          </h2>
          <ol className="space-y-px">
            {course.lessons.map((lesson) => {
              const selected =
                selection.kind === 'lesson' && lesson.lessonId === selection.lessonId;
              return (
                <li key={lesson.lessonId}>
                  <Link
                    href={lesson.url}
                    onClick={onNavigate}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={`${lesson.lessonOrder}. ${lesson.title}`}
                    title={lesson.title}
                    className={cn(
                      'grid h-7 grid-cols-[20px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-[13px] leading-4 transition-colors',
                      selected
                        ? 'bg-brand/12 font-medium text-brand'
                        : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground',
                    )}
                  >
                    <span
                      className="flex size-5 items-center justify-center rounded-[4px] border border-current/20 font-mono text-[10px]"
                    >
                      {lesson.lessonOrder}
                    </span>
                    <span className="truncate">{lesson.title}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}

export function LearnSidebar({
  curriculum,
  selection,
}: {
  curriculum: Curriculum;
  selection: LearnSelection;
}) {
  return (
    <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto border-r px-2.5 py-5 lg:block">
      <CurriculumNavigation curriculum={curriculum} selection={selection} />
    </aside>
  );
}
