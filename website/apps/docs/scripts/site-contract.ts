export interface RouteExpectation {
  path: string;
  status: number;
  includes: readonly string[];
  excludes: readonly string[];
  location?: string;
}

export interface SiteAuditFailure {
  path: string;
  reason: string;
}

export interface SiteAuditResult {
  failures: SiteAuditFailure[];
  checked: number;
}

interface SiteAuditDependencies {
  fetch: typeof fetch;
}

export const routeExpectations: readonly RouteExpectation[] = [
  {
    path: '/',
    status: 200,
    includes: [
      'Build autonomous',
      'under human',
      'Read https://github.com/akua-dev/agentos/blob/main/BOOTSTRAP.md',
      'From one answer to a company.',
    ],
    excludes: [
      'Fumadocs',
      'shadcn',
      'Turbo DX at Vercel',
      'This is a Callout',
      'Next.js',
      'React Router',
      'Waku',
    ],
  },
  {
    path: '/blog',
    status: 308,
    includes: [],
    excludes: [],
    location: '/learn',
  },
  {
    path: '/docs',
    status: 200,
    includes: ['AgentOS documentation'],
    excludes: ['The framework for building documentation sites'],
  },
  {
    path: '/learn',
    status: 200,
    includes: [
      'What is an autonomous company?',
      'Get a working Fleet first',
      'What you will be able to run',
    ],
    excludes: ['Fumadocs Blog'],
  },
  {
    path: '/benchmarks',
    status: 200,
    includes: ['Measure the organization', '3 of 5', 'failed and incomplete'],
    excludes: ['customer testimonial'],
  },
  {
    path: '/banner.png',
    status: 200,
    includes: [],
    excludes: [],
  },
  ...documentationRoutes.slice(1).map(
    (route): RouteExpectation => ({
      path: route.path,
      status: 200,
      includes: [route.title, 'Canonical sources'],
      excludes: ['Fumadocs'],
    }),
  ),
  ...learningRoutes.map(
    (route): RouteExpectation => ({
      path: route.path,
      status: 200,
      includes: [route.title, 'Canonical sources'],
      excludes: ['Fumadocs'],
    }),
  ),
  {
    path: '/sitemap.xml',
    status: 200,
    includes: [
      '/docs/start/get-started',
      '/learn/01-first-outcome/bring-agentos-online',
      '/learn/03-stay-in-control/upgrade-without-losing-control',
    ],
    excludes: ['/showcase', '/blog/why-docs'],
  },
  {
    path: '/llms.txt',
    status: 200,
    includes: ['## Documentation', '## Learn', 'Upgrade without losing control'],
    excludes: ['Fumadocs UI'],
  },
  {
    path: '/llms-full.txt',
    status: 200,
    includes: ['Bring AgentOS online', 'Upgrade without losing control', 'Canonical sources:'],
    excludes: ['raw.githubusercontent.com/fuma-nama'],
  },
  {
    path: '/api/search?query=sovereign',
    status: 200,
    includes: ['upgrade-without-losing-control', 'Learn'],
    excludes: ['Fumadocs'],
  },
  ...[
    '/showcase',
    '/blog/why-docs',
    '/docs/ui',
    '/docs/headless',
    '/docs/mdx',
    '/docs/openapi',
    '/docs/asyncapi',
  ].map(
    (path): RouteExpectation => ({
      path,
      status: 404,
      includes: [],
      excludes: [],
    }),
  ),
];

export async function auditSite(
  baseUrl: string | URL,
  expectations: readonly RouteExpectation[] = routeExpectations,
  dependencies: SiteAuditDependencies = { fetch },
): Promise<SiteAuditResult> {
  const origin = new URL(baseUrl);
  const failures: SiteAuditFailure[] = [];

  for (const expectation of expectations) {
    let response: Response;

    try {
      response = await dependencies.fetch(new URL(expectation.path, origin), {
        redirect: 'manual',
      });
    } catch (error) {
      failures.push({
        path: expectation.path,
        reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (response.status !== expectation.status) {
      failures.push({
        path: expectation.path,
        reason: `expected status ${expectation.status}, received ${response.status}`,
      });
    }

    const body = await response.text();
    for (const required of expectation.includes) {
      if (!body.includes(required)) {
        failures.push({
          path: expectation.path,
          reason: `missing required text: ${required}`,
        });
      }
    }

    for (const forbidden of expectation.excludes) {
      if (body.includes(forbidden)) {
        failures.push({
          path: expectation.path,
          reason: `found forbidden text: ${forbidden}`,
        });
      }
    }

    if (expectation.location) {
      const actual = response.headers.get('location');
      const actualPath = actual ? new URL(actual, origin).pathname : null;

      if (actualPath !== expectation.location) {
        failures.push({
          path: expectation.path,
          reason: `expected location ${expectation.location}, received ${actualPath ?? 'none'}`,
        });
      }
    }
  }

  return {
    checked: expectations.length,
    failures,
  };
}

if (import.meta.main) {
  const result = await auditSite(
    process.env.AGENTOS_SITE_BASE_URL ?? 'http://127.0.0.1:3100',
  );

  for (const failure of result.failures) {
    console.error(`${failure.path}: ${failure.reason}`);
  }

  if (result.failures.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`Checked ${result.checked} public routes with no failures.`);
  }
}
import { documentationRoutes } from './docs-contract';
import { learningRoutes } from './learn-contract';
