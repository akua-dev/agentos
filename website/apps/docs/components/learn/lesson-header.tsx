import { Clock } from 'lucide-react';
import type { Lesson } from '@/lib/learn/curriculum';

export function LessonHeader({ lesson }: { lesson: Lesson }) {
  return (
    <header className="mb-10 border-b pb-8">
      <p className="mb-4 text-xs font-medium tracking-wide text-brand uppercase">
        Course {lesson.courseOrder}: {lesson.courseTitle} · Chapter {lesson.lessonOrder}
      </p>
      <h1 className="mb-4 text-3xl font-semibold tracking-[-0.035em] text-balance md:text-5xl">
        {lesson.title}
      </h1>
      <p className="max-w-[65ch] text-lg text-pretty text-fd-muted-foreground">
        {lesson.description}
      </p>
      <p className="mt-5 inline-flex items-center gap-1.5 text-xs text-fd-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        {lesson.estimatedMinutes} minute chapter
      </p>
    </header>
  );
}
