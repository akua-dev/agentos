import { describe, expect, it } from 'vitest';
import { learningRoutes } from './learn-contract';

describe('learningRoutes', () => {
  it('defines three activation-first courses and ten chapters', () => {
    expect(learningRoutes).toHaveLength(10);
    expect([...new Set(learningRoutes.map((route) => route.course))]).toEqual([
      'Run your first outcome',
      'Grow the company',
      'Stay in control',
    ]);
  });

  it('keeps stable unique paths, lesson IDs and global positions', () => {
    expect(new Set(learningRoutes.map((route) => route.path)).size).toBe(10);
    expect(new Set(learningRoutes.map((route) => route.lessonId)).size).toBe(10);
    expect(learningRoutes.map((route) => route.position)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
  });

  it('begins with a working Fleet and ends with a controlled upgrade', () => {
    expect(learningRoutes[0]).toMatchObject({
      path: '/learn/01-first-outcome/bring-agentos-online',
      title: 'Bring AgentOS online',
    });
    expect(learningRoutes.at(-1)).toMatchObject({
      path: '/learn/03-stay-in-control/upgrade-without-losing-control',
      title: 'Upgrade without losing control',
    });
  });
});
