import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Effect, Schema } from 'effect';
import { LearnLayout } from '@/components/learn/learn-layout';
import { LessonHeader } from '@/components/learn/lesson-header';
import { LessonNavigation } from '@/components/learn/lesson-navigation';
import { LessonProgress } from '@/components/learn/lesson-progress';
import { CanonicalSources } from '@/components/canonical-source';
import { getMDXComponents } from '@/components/mdx';
import { runServerEffect } from '@/lib/effect/server-runtime';
import { getCurriculum } from '@/lib/learn/curriculum.server';
import { findLesson, getLessonNeighbors } from '@/lib/learn/curriculum';
import { createMetadata, createNotFoundMetadata } from '@/lib/metadata';
import { learnSource } from '@/lib/source';

export const revalidate = false;

class LearnPageRenderError extends
  Schema.TaggedErrorClass<LearnPageRenderError>()('LearnPageRenderError', {
    code: Schema.Literals(['not_found', 'load_failed']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

const renderLesson = Effect.fn('agentos.website.renderLesson')(
  function*(props: PageProps<'/learn/[...slug]'>) {
    const { slug } = yield* Effect.promise(() => props.params);
    const page = learnSource.getPage(slug);
    if (page === undefined) {
      return yield* new LearnPageRenderError({
        code: 'not_found',
        message: 'Lesson not found',
      });
    }
    const curriculum = yield* getCurriculum;
    const lesson = findLesson(curriculum, page.data.lessonId);
    if (lesson === undefined) {
      return yield* new LearnPageRenderError({
        code: 'not_found',
        message: 'Lesson missing from curriculum',
      });
    }
    const { body: Mdx, toc } = yield* Effect.tryPromise({
      try: () => page.data.load(),
      catch: (cause) =>
        new LearnPageRenderError({
          code: 'load_failed',
          message: `Could not load lesson: ${page.url}`,
          cause,
        }),
    });
    const neighbors = getLessonNeighbors(curriculum, lesson.lessonId);

    return (
      <LearnLayout
        curriculum={curriculum}
        selection={{ kind: 'lesson', lessonId: lesson.lessonId }}
        lesson={lesson}
        toc={toc}
      >
        <article className="mx-auto max-w-[704px]">
          <LessonHeader lesson={lesson} />
          <details className="mb-7 rounded-lg border p-4 xl:hidden">
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
          <div className="mt-7 xl:hidden">
            <LessonProgress
              lessonId={lesson.lessonId}
              validLessonIds={curriculum.lessons.map((item) => item.lessonId)}
            />
          </div>
          <LessonNavigation {...neighbors} />
        </article>
      </LearnLayout>
    );
  },
);

export default function Page(props: PageProps<'/learn/[...slug]'>) {
  return runServerEffect(
    renderLesson(props).pipe(
      Effect.catchTag(
        'LearnPageRenderError',
        (error) =>
          error.code === 'not_found'
            ? Effect.sync(() => notFound())
            : Effect.fail(error),
      ),
    ),
  );
}

const renderMetadata = Effect.fn('agentos.website.renderLessonMetadata')(
  function*(props: PageProps<'/learn/[...slug]'>): Effect.fn.Return<Metadata> {
    const { slug } = yield* Effect.promise(() => props.params);
    const page = learnSource.getPage(slug);
    if (page === undefined) return createNotFoundMetadata('Lesson not found');
    return createMetadata({
      title: page.data.title,
      description: page.data.description ?? 'Learn AgentOS',
      path: page.url,
    });
  },
);

export function generateMetadata(
  props: PageProps<'/learn/[...slug]'>,
): Promise<Metadata> {
  return runServerEffect(renderMetadata(props));
}

export function generateStaticParams() {
  return learnSource.generateParams();
}
