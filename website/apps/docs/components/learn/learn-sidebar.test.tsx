// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildCurriculum, type LearnPageRecord } from '@/lib/learn/curriculum';
import { CurriculumNavigation } from './learn-sidebar';

afterEach(() => {
  cleanup();
});

const records: LearnPageRecord[] = [
  {
    title: 'First lesson',
    description: 'First description',
    url: '/learn/one/first',
    courseId: 'one',
    courseTitle: 'Course one',
    courseOrder: 1,
    lessonId: 'first',
    lessonOrder: 1,
    estimatedMinutes: 2,
  },
  {
    title: 'Second lesson',
    description: 'Second description',
    url: '/learn/one/second',
    courseId: 'one',
    courseTitle: 'Course one',
    courseOrder: 1,
    lessonId: 'second',
    lessonOrder: 2,
    estimatedMinutes: 2,
  },
  {
    title: 'Third lesson',
    description: 'Third description',
    url: '/learn/two/third',
    courseId: 'two',
    courseTitle: 'Course two',
    courseOrder: 2,
    lessonId: 'third',
    lessonOrder: 1,
    estimatedMinutes: 3,
  },
];

const curriculum = buildCurriculum(records);

describe('CurriculumNavigation', () => {
  it('selects the introduction before the complete numbered curriculum', () => {
    render(
      <CurriculumNavigation
        curriculum={curriculum}
        selection={{ kind: 'introduction' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Introduction' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getAllByRole('link')).toHaveLength(records.length + 1);
    expect(screen.getByRole('heading', { name: '1. Course one' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '2. Course two' })).toBeTruthy();
  });

  it('selects exactly one numbered lesson', () => {
    render(
      <CurriculumNavigation
        curriculum={curriculum}
        selection={{ kind: 'lesson', lessonId: 'second' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Introduction' }).hasAttribute('aria-current')).toBe(
      false,
    );
    expect(
      screen.getByRole('link', { name: /2\s*Second lesson/ }).getAttribute('aria-current'),
    ).toBe('page');
  });
});
