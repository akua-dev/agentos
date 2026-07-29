import { describe, expect, it } from 'vitest';
import { learningRoutes } from './learn-contract';

describe('learningRoutes', () => {
  it('defines exactly four courses and 33 chapters', () => {
    expect(learningRoutes).toHaveLength(33);
    expect(new Set(learningRoutes.map((route) => route.course)).size).toBe(4);
  });

  it('keeps stable unique paths, lesson IDs and global positions', () => {
    expect(new Set(learningRoutes.map((route) => route.path)).size).toBe(33);
    expect(new Set(learningRoutes.map((route) => route.lessonId)).size).toBe(33);
    expect(learningRoutes.map((route) => route.position)).toEqual(
      Array.from({ length: 33 }, (_, index) => index + 1),
    );
  });

  it('begins at models and ends at sovereignty', () => {
    expect(learningRoutes[0]).toMatchObject({
      path: '/learn/01-models-to-agents/what-a-model-does',
      title: 'What a model does',
    });
    expect(learningRoutes.at(-1)).toMatchObject({
      path: '/learn/04-build-autonomous-company/keep-company-sovereign',
      title: 'Keep the company sovereign',
    });
  });
});
