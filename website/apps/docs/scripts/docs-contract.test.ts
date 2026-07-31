import { describe, expect, it } from 'vitest';
import { documentationRoutes } from './docs-contract';

describe('documentationRoutes', () => {
  it('defines the complete ordered AgentOS documentation map', () => {
    expect(documentationRoutes).toHaveLength(58);
    expect(documentationRoutes[0]).toMatchObject({ path: '/docs', title: 'AgentOS documentation' });
    expect(documentationRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/docs/concepts/human-work-surfaces',
          title: 'Human work surfaces',
        }),
        expect.objectContaining({
          path: '/docs/operate/continue-local-work',
          title: 'Continue local work with the Fleet',
        }),
      ]),
    );
    expect(documentationRoutes).toContainEqual({
      path: '/docs/concepts/progressive-planning',
      title: 'Progressive planning',
      group: 'concepts',
      canonicalRequired: true,
    });
    expect(documentationRoutes.at(-1)).toMatchObject({
      path: '/docs/contribute/releases',
      title: 'Release model',
    });
  });

  it('contains no duplicate route or title', () => {
    expect(new Set(documentationRoutes.map((route) => route.path)).size).toBe(
      documentationRoutes.length,
    );
    expect(new Set(documentationRoutes.map((route) => route.title)).size).toBe(
      documentationRoutes.length,
    );
  });

  it('keeps groups in the approved order', () => {
    const groups = [...new Set(documentationRoutes.slice(1).map((route) => route.group))];
    expect(groups).toEqual([
      'start',
      'concepts',
      'operate',
      'architecture',
      'reference',
      'contribute',
    ]);
  });

  it('requires canonical sources for every non-root page', () => {
    expect(documentationRoutes.filter((route) => !route.canonicalRequired)).toEqual([
      documentationRoutes[0],
    ]);
  });
});
