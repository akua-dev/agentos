import { describe, expect, it } from 'vitest';
import { learningRoutes } from './learn-contract';

describe('learningRoutes', () => {
  it('defines three activation-first courses and twelve chapters', () => {
    expect(learningRoutes).toHaveLength(12);
    expect([...new Set(learningRoutes.map((route) => route.course))]).toEqual([
      'Run your first outcome',
      'Grow the company',
      'Stay in control',
    ]);
  });

  it('keeps stable unique paths, lesson IDs and global positions', () => {
    expect(new Set(learningRoutes.map((route) => route.path)).size).toBe(12);
    expect(new Set(learningRoutes.map((route) => route.lessonId)).size).toBe(12);
    expect(learningRoutes.map((route) => route.position)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it('begins with a working Fleet and ends with a controlled upgrade', () => {
    expect(learningRoutes[0]).toMatchObject({
      path: '/learn/01-first-outcome/bring-agentos-online',
      title: 'Bring AgentOS online',
    });
    expect(learningRoutes[2]).toMatchObject({
      path: '/learn/01-first-outcome/hand-off-local-work',
      title: 'Hand off local work',
      position: 3,
    });
    expect(learningRoutes[3]).toMatchObject({
      path: '/learn/01-first-outcome/let-plan-emerge',
      title: 'Let the plan emerge',
      position: 4,
    });
    expect(learningRoutes.at(-1)).toMatchObject({
      path: '/learn/03-stay-in-control/upgrade-without-losing-control',
      title: 'Upgrade without losing control',
    });
  });
});
