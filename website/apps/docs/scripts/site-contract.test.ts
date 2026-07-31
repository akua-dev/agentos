import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { auditSite, routeExpectations, type RouteExpectation } from './site-contract';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const renderedRoutePaths = [
  '/does-not-exist',
  '/docs/does-not-exist',
  '/learn/does-not-exist',
] as const;
const realFleetEvidencePath = '/docs/concepts/progressive-planning-in-practice';
const simplifiedTutorialPath = '/learn/01-first-outcome/let-plan-emerge';

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine test port');
  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return port;
}

async function waitForSite(baseUrl: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('Next development server exited early');

    try {
      const response = await fetch(new URL('/does-not-exist', baseUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 404) return;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for Next development server');
}

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
    expect(paths).toHaveLength(94);
    expect(paths).toContain('/favicon.ico');
    expect(paths).toContain('/icon.png');
    expect(paths).toContain('/apple-icon.png');
    expect(paths).toContain('/opengraph-image.png');
    expect(paths).toContain('/robots.txt');
    expect(paths).not.toContain('/banner.png');
    expect(paths).toContain('/docs/operate/supervise-steer');
    expect(paths).toContain('/learn/03-stay-in-control/upgrade-without-losing-control');
    expect(paths).toContain('/api/search?query=sovereign');
    expect(paths).toContain('/does-not-exist');
    expect(paths).toContain('/docs/does-not-exist');
    expect(paths).toContain('/learn/does-not-exist');
    expect(paths).toContain('/showcase');
  });

  it('does not require Learn chapter structure on documentation routes', () => {
    const docsExpectation = routeExpectations.find(
      (expectation) => expectation.path === '/docs/start/get-started',
    );

    expect(docsExpectation?.includes).toEqual([
      'Get started',
      'Canonical sources',
      'https://agentos.akua.dev/docs/start/get-started',
    ]);
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

describe('rendered site contract', () => {
  let siteBaseUrl: string;
  let siteProcess: ChildProcess | undefined;

  beforeAll(async () => {
    const configuredBaseUrl = process.env.AGENTOS_SITE_BASE_URL;
    if (configuredBaseUrl) {
      siteBaseUrl = configuredBaseUrl;
      return;
    }

    const port = await findAvailablePort();
    siteBaseUrl = `http://127.0.0.1:${port}`;
    siteProcess = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)),
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: appDirectory,
        env: { ...process.env, NODE_ENV: 'development' },
        stdio: 'ignore',
      },
    );
    await waitForSite(siteBaseUrl, siteProcess);
  }, 120_000);

  afterAll(() => {
    siteProcess?.kill('SIGTERM');
  });

  it('audits rendered global and route-local 404 metadata HTML', async () => {
    const expectations = routeExpectations.filter((expectation) =>
      renderedRoutePaths.includes(expectation.path as (typeof renderedRoutePaths)[number]),
    );

    expect(expectations).toHaveLength(renderedRoutePaths.length);
    const result = await auditSite(siteBaseUrl, expectations);

    expect(result).toEqual({
      checked: renderedRoutePaths.length,
      failures: [],
    });
  }, 120_000);

  it('renders sanitized evidence from a real Fleet', async () => {
    const expectations = routeExpectations.filter(
      (expectation) => expectation.path === realFleetEvidencePath,
    );

    expect(expectations).toHaveLength(1);
    const renderedExpectations = expectations.map((expectation) => ({
      ...expectation,
      includes: expectation.includes.filter(
        (required) => required !== `https://agentos.akua.dev${realFleetEvidencePath}`,
      ),
    }));
    const result = await auditSite(siteBaseUrl, renderedExpectations);

    expect(result).toEqual({ checked: 1, failures: [] });
  }, 120_000);

  it('renders the simplified progressive-planning tutorial', async () => {
    const expectations = routeExpectations.filter(
      (expectation) => expectation.path === simplifiedTutorialPath,
    );

    expect(expectations).toHaveLength(1);
    const renderedExpectations = expectations.map((expectation) => ({
      ...expectation,
      includes: expectation.includes.filter(
        (required) => required !== `https://agentos.akua.dev${simplifiedTutorialPath}`,
      ),
    }));
    const result = await auditSite(siteBaseUrl, renderedExpectations);

    expect(result).toEqual({ checked: 1, failures: [] });
  }, 120_000);

  it('emits one robots directive for each rendered 404', async () => {
    for (const path of renderedRoutePaths) {
      const response = await fetch(new URL(path, siteBaseUrl));
      const html = await response.text();
      const robots = [...html.matchAll(/<meta name="robots" content="([^"]+)"\/?>/g)].map(
        (match) => match[1],
      );

      expect(robots, path).toEqual(['noindex']);
    }
  }, 120_000);
});
