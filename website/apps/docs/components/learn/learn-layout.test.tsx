// @vitest-environment jsdom

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildCurriculum, type LearnPageRecord } from '@/lib/learn/curriculum';
import { LearnLayout } from './learn-layout';

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe('LearnLayout', () => {
  it.effect('lets the desktop navigation rails reach the viewport edges', () =>
    Effect.gen(function*() {
    const record: LearnPageRecord = {
      title: 'Begin',
      description: 'Begin here.',
      url: '/learn/first/begin',
      courseId: 'first',
      courseTitle: 'First',
      courseOrder: 1,
      lessonId: 'begin',
      lessonOrder: 1,
      estimatedMinutes: 2,
    };

    const curriculum = yield* buildCurriculum([record]);
    yield* Effect.sync(() => {
      render(
        <LearnLayout
        curriculum={curriculum}
        selection={{ kind: 'introduction' }}
        toc={[]}
      >
        Introduction
      </LearnLayout>,
      );

    const shell = screen.getByRole('main').parentElement;

      expect(shell?.style.maxWidth).toBe('none');
    });
  }));

  it.effect('describes progress using the actual curriculum size', () =>
    Effect.gen(function*() {
    const record: LearnPageRecord = {
      title: 'Begin',
      description: 'Begin here.',
      url: '/learn/first/begin',
      courseId: 'first',
      courseTitle: 'First',
      courseOrder: 1,
      lessonId: 'begin',
      lessonOrder: 1,
      estimatedMinutes: 2,
    };

    const curriculum = yield* buildCurriculum([record]);
    yield* Effect.sync(() => {
      render(
        <LearnLayout
        curriculum={curriculum}
        selection={{ kind: 'introduction' }}
        toc={[]}
      >
        Introduction
      </LearnLayout>,
      );

      expect(screen.getByText(/progress counts the 1 chapter\./i)).toBeTruthy();
    });
  }));
});
