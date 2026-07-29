import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Curriculum } from '@/lib/learn/curriculum';

export function CurriculumNavigation({
  curriculum,
  selectedLessonId,
  onNavigate,
}: {
  curriculum: Curriculum;
  selectedLessonId?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Learn curriculum">
      {curriculum.courses.map((course) => (
        <section key={course.id} className="mb-7">
          <h2 className="mb-2 px-3 text-xs font-medium tracking-wide text-fd-muted-foreground uppercase">
            {course.order}. {course.title}
          </h2>
          <ol className="space-y-0.5">
            {course.lessons.map((lesson) => {
              const selected = lesson.lessonId === selectedLessonId;
              return (
                <li key={lesson.lessonId}>
                  <Link
                    href={lesson.url}
                    onClick={onNavigate}
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'grid grid-cols-[24px_1fr] gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      selected
                        ? 'bg-brand/12 font-medium text-brand'
                        : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground',
                    )}
                  >
                    <span className="font-mono text-xs leading-5">{lesson.lessonOrder}</span>
                    <span>{lesson.title}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <Link
        href="/learn"
        onClick={onNavigate}
        className="mx-3 inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
      >
        <CheckCircle2 className="size-4" aria-hidden />
        Course map
      </Link>
    </nav>
  );
}

export function LearnSidebar({
  curriculum,
  selectedLessonId,
}: {
  curriculum: Curriculum;
  selectedLessonId?: string;
}) {
  return (
    <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto border-r px-3 py-7 lg:block">
      <CurriculumNavigation curriculum={curriculum} selectedLessonId={selectedLessonId} />
    </aside>
  );
}
