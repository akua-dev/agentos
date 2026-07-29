import { Clock } from 'lucide-react';
import type { Lesson } from '@/lib/learn/curriculum';

export function LessonHeader({ lesson }: { lesson: Lesson }) {
  return (
    <header className="mb-8 border-b pb-7">
      <p className="mb-3 font-mono text-[11px] font-medium text-brand">
        Course {lesson.courseOrder}: {lesson.courseTitle} · Chapter {lesson.lessonOrder}
      </p>
      <h1 className="max-w-[18ch] text-3xl leading-[1.04] font-semibold tracking-[-0.04em] text-balance md:text-5xl">
        {lesson.title}
      </h1>
      <p className="mt-4 max-w-[62ch] text-base leading-7 text-pretty text-fd-muted-foreground">
        {lesson.description}
      </p>
      <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-fd-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        {lesson.estimatedMinutes} minute chapter
      </p>
    </header>
  );
}
