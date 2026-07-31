// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CourseIntroduction } from './course-introduction';

afterEach(() => {
  cleanup();
});

describe('CourseIntroduction', () => {
  it('offers the first working Fleet before teaching the conceptual progression', () => {
    render(
      <CourseIntroduction firstLessonUrl="/learn/01-first-outcome/bring-agentos-online" />,
    );

    expect(
      screen.getByRole('heading', { name: 'What is an autonomous company?' }),
    ).toBeTruthy();
    expect(screen.getByText(/human-led organization/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /get a working Fleet first/i })).toBeTruthy();
    expect(screen.getByText(/first useful win/i)).toBeTruthy();
    const startLink = screen.getByRole('link', { name: /bring AgentOS online/i });
    expect(startLink.getAttribute('href')).toBe(
      '/learn/01-first-outcome/bring-agentos-online',
    );
    expect(screen.getByRole('heading', { name: 'From one answer to a company' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'What you will be able to run' }),
    ).toBeTruthy();
    expect(screen.getByText(/persistent First Mate/i)).toBeTruthy();
    expect(screen.getByText(/first six chapters/i)).toBeTruthy();
    expect(screen.getByText(/eleven short chapters/i)).toBeTruthy();

    const progressionHeading = screen.getByRole('heading', {
      name: 'From one answer to a company',
    });
    expect(
      startLink.compareDocumentPosition(progressionHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('exposes the model-to-company progression as one ordered sequence', () => {
    render(
      <CourseIntroduction firstLessonUrl="/learn/01-first-outcome/bring-agentos-online" />,
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
