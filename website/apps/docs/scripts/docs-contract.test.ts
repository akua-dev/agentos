import { describe, expect, it } from 'vitest';
import { documentationRoutes } from './docs-contract';

describe('documentationRoutes', () => {
  it('defines the complete ordered AgentOS documentation map', () => {
    expect(documentationRoutes).toHaveLength(55);
    expect(documentationRoutes[0]).toMatchObject({ path: '/docs', title: 'AgentOS documentation' });
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
