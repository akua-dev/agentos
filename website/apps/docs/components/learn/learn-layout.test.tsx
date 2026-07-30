// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildCurriculum, type LearnPageRecord } from '@/lib/learn/curriculum';
import { LearnLayout } from './learn-layout';

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe('LearnLayout', () => {
  it('describes progress using the actual curriculum size', () => {
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

    render(
      <LearnLayout
        curriculum={buildCurriculum([record])}
        selection={{ kind: 'introduction' }}
        toc={[]}
      >
        Introduction
      </LearnLayout>,
    );

    expect(screen.getByText(/progress counts the 1 chapter\./i)).toBeTruthy();
  });
});
