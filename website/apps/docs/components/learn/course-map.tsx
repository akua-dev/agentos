'use client';

import Link from 'next/link';
import { ArrowRight, BookOpen, Clock } from 'lucide-react';
import { useMemo } from 'react';
import type { Curriculum } from '@/lib/learn/curriculum';
import { LearnProgressSummary, useLearnProgress } from './lesson-progress';

export function CourseMap({ curriculum }: { curriculum: Curriculum }) {
  const lessonIds = useMemo(
    () => curriculum.lessons.map((lesson) => lesson.lessonId),
    [curriculum.lessons],
  );
  const { completed } = useLearnProgress(lessonIds);
  const completedSet = new Set(completed);
  const nextLesson =
    curriculum.lessons.find((lesson) => !completedSet.has(lesson.lessonId)) ??
    curriculum.lessons.at(-1);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-4">
        {nextLesson && (
          <Link
            href={nextLesson.url}
            className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-3 font-medium text-brand-foreground transition-colors hover:bg-brand-200"
          >
            {completed.length > 0 ? 'Continue' : 'Start course'}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
        <LearnProgressSummary validLessonIds={lessonIds} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {curriculum.courses.map((course) => (
          <section key={course.id} className="rounded-2xl border bg-fd-card p-6 shadow-sm">
            <div className="mb-5 flex items-start gap-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border font-mono text-sm text-brand">
                {course.order}
              </span>
              <div>
                <h2 className="text-xl font-medium tracking-tight">{course.title}</h2>
                <p className="mt-1 flex items-center gap-3 text-xs text-fd-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <BookOpen className="size-3.5" aria-hidden />
                    {course.lessons.length} chapters
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" aria-hidden />
                    {course.estimatedMinutes} min
                  </span>
                </p>
              </div>
            </div>
            <ol className="space-y-1">
              {course.lessons.map((lesson) => (
                <li key={lesson.lessonId}>
                  <Link
                    href={lesson.url}
                    className="group flex items-start gap-3 rounded-lg px-2 py-2 text-sm hover:bg-fd-accent"
                  >
                    <span className="mt-0.5 w-5 shrink-0 font-mono text-xs text-fd-muted-foreground">
                      {lesson.lessonOrder}
                    </span>
                    <span className="group-hover:text-brand">{lesson.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
