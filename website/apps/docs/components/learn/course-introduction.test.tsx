// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CourseIntroduction } from './course-introduction';

afterEach(() => {
  cleanup();
});

describe('CourseIntroduction', () => {
  it('defines the destination before starting the numbered course', () => {
    render(
      <CourseIntroduction firstLessonUrl="/learn/01-models-to-agents/what-a-model-does" />,
    );

    expect(
      screen.getByRole('heading', { name: 'What is an autonomous company?' }),
    ).toBeTruthy();
    expect(screen.getByText(/human-led organization/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'From one answer to a company' })).toBeTruthy();
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('Autonomous company')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'What you will be able to run' }),
    ).toBeTruthy();
    expect(screen.getByText(/persistent First Mate/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /begin with models/i }).getAttribute('href')).toBe(
      '/learn/01-models-to-agents/what-a-model-does',
    );
  });
});
