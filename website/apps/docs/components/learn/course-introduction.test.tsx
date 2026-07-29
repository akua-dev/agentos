// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

  it('exposes the model-to-company progression as one ordered sequence', () => {
    render(
      <CourseIntroduction firstLessonUrl="/learn/01-models-to-agents/what-a-model-does" />,
    );

    const progression = screen.getByRole('list', {
      name: 'Progression from model to autonomous company',
    });
    const steps = within(progression).getAllByRole('listitem');

    expect(steps).toHaveLength(7);
    expect(steps[0].textContent).toContain('Model');
    expect(steps[6].textContent).toContain('Autonomous company');
  });
});
