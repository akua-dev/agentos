import { describe, expect, it } from 'vitest';
import { auditSite, routeExpectations, type RouteExpectation } from './site-contract';

function createFetch(
  responses: Readonly<Record<string, { status: number; body?: string; location?: string }>>,
): typeof fetch {
  return (async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    const response = responses[url.pathname];

    if (!response) {
      return new Response('not found', { status: 404 });
    }

    return new Response(response.body ?? '', {
      status: response.status,
      headers: response.location ? { location: response.location } : undefined,
    });
  }) as typeof fetch;
}

describe('auditSite', () => {
  const expectation: RouteExpectation = {
    path: '/',
    status: 200,
    includes: ['AgentOS'],
    excludes: ['Fumadocs'],
  };

  it('accepts a matching public response', async () => {
    const result = await auditSite('https://agentos.example', [expectation], {
      fetch: createFetch({
        '/': { status: 200, body: '<h1>AgentOS</h1>' },
      }),
    });

    expect(result).toEqual({ checked: 1, failures: [] });
  });

  it('reports status, required text, and forbidden text failures', async () => {
    const result = await auditSite('https://agentos.example', [expectation], {
      fetch: createFetch({
        '/': { status: 500, body: '<h1>Fumadocs</h1>' },
      }),
    });

    expect(result.failures.map((failure) => failure.reason)).toEqual([
      'expected status 200, received 500',
      'missing required text: AgentOS',
      'found forbidden text: Fumadocs',
    ]);
  });

  it('checks permanent redirects without following them', async () => {
    const redirect: RouteExpectation = {
      path: '/blog',
      status: 308,
      includes: [],
      excludes: [],
      location: '/learn',
    };

    const result = await auditSite('https://agentos.example', [redirect], {
      fetch: createFetch({
        '/blog': { status: 308, location: '/wrong' },
      }),
    });

    expect(result.failures).toEqual([
      {
        path: '/blog',
        reason: 'expected location /learn, received /wrong',
      },
    ]);
  });

  it('defines the complete Landing, Docs, Learn, discovery, and removal contract', () => {
    const paths = routeExpectations.map((expectation) => expectation.path);
    expect(paths).toHaveLength(81);
    expect(paths).toContain('/docs/operate/supervise-steer');
    expect(paths).toContain('/learn/03-stay-in-control/upgrade-without-losing-control');
    expect(paths).toContain('/api/search?query=sovereign');
    expect(paths).toContain('/showcase');
  });

  it('does not require Learn chapter structure on documentation routes', () => {
    const docsExpectation = routeExpectations.find(
      (expectation) => expectation.path === '/docs/start/get-started',
    );

    expect(docsExpectation?.includes).toEqual(['Get started', 'Canonical sources']);
    expect(docsExpectation?.includes).not.toContain('What changes at this layer?');
  });

  it('accepts a missing copied product route', async () => {
    const removed: RouteExpectation = {
      path: '/showcase',
      status: 404,
      includes: [],
      excludes: [],
    };

    const result = await auditSite('https://agentos.example', [removed], {
      fetch: createFetch({}),
    });

    expect(result).toEqual({ checked: 1, failures: [] });
  });
});
