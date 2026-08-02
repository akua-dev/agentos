import {
  Config,
  Effect,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { documentationRoutes } from './docs-contract';
import { learningRoutes } from './learn-contract';
import { runWebsiteScript } from './script-runtime';

const productionOrigin = 'https://agentos.akua.dev';

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
  readonly failures: ReadonlyArray<SiteAuditFailure>;
  readonly checked: number;
}

export interface SiteAuditResponse {
  readonly status: number;
  readonly body: string;
  readonly location?: string;
}

export interface SiteAuditDependencies {
  readonly request: (
    url: URL,
  ) => Effect.Effect<SiteAuditResponse, SiteAuditRequestError>;
}

export class SiteAuditRequestError extends
  Schema.TaggedErrorClass<SiteAuditRequestError>()('SiteAuditRequestError', {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

export class SiteAuditError extends Schema.TaggedErrorClass<SiteAuditError>()(
  'SiteAuditError',
  {
    code: Schema.Literals(['configuration', 'contract', 'stdio']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    failures: Schema.optional(Schema.Number),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

const notFoundRouteExpectation = (path: string): RouteExpectation => ({
  path,
  status: 404,
  includes: ['noindex'],
  excludes: [
    '<link rel="canonical"',
    '<meta property="og:url"',
    '<meta name="twitter:',
    'index, follow',
    'index,follow',
  ],
});

export const routeExpectations: readonly RouteExpectation[] = [
  {
    path: '/',
    status: 200,
    includes: [
      'Build autonomous',
      'under human',
      'Read https://github.com/akua-dev/agentos/blob/main/BOOTSTRAP.md',
      'From one answer to a company.',
      `${productionOrigin}/`,
      `${productionOrigin}/opengraph-image.png`,
      'SoftwareSourceCode',
    ],
    excludes: [
      'banner.png',
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
    includes: ['AgentOS documentation', `${productionOrigin}/docs`],
    excludes: ['The framework for building documentation sites'],
  },
  {
    path: '/learn',
    status: 200,
    includes: [
      'What is an autonomous company?',
      'Get a working Fleet first',
      'What you will be able to run',
      `${productionOrigin}/learn`,
    ],
    excludes: ['Fumadocs Blog'],
  },
  {
    path: '/benchmarks',
    status: 200,
    includes: [
      'Measure the organization',
      '3 of 5',
      'failed and incomplete',
      `${productionOrigin}/benchmarks`,
    ],
    excludes: ['customer testimonial'],
  },
  ...['/favicon.ico', '/icon.png', '/apple-icon.png', '/opengraph-image.png'].map(
    (path): RouteExpectation => ({
      path,
      status: 200,
      includes: [],
      excludes: [],
    }),
  ),
  notFoundRouteExpectation('/does-not-exist'),
  notFoundRouteExpectation('/docs/does-not-exist'),
  notFoundRouteExpectation('/learn/does-not-exist'),
  ...documentationRoutes.slice(1).map(
    (route): RouteExpectation => ({
      path: route.path,
      status: 200,
      includes: [
        route.title,
        'Canonical sources',
        `${productionOrigin}${route.path}`,
        ...(route.path === '/docs/concepts/progressive-planning-in-practice'
          ? [
              'Observed in a real Fleet',
              '15 durable Tasks',
              '57 public sources',
              'AI Gateway repair Task',
              'Separately authorized release/rollout Task',
              '8,721 SSE events',
              'five persistent Mates',
              'no competing pull request',
            ]
          : []),
      ],
      excludes: [
        'Fumadocs',
        ...(route.path === '/docs/concepts/progressive-planning-in-practice'
          ? [
              'Wayfinder',
              '$1B',
              'PR #49',
              'v0.1.14',
              'v0.1.15',
              'openai-codex',
              '/home/agent',
            ]
          : []),
      ],
    }),
  ),
  ...learningRoutes.map(
    (route): RouteExpectation => ({
      path: route.path,
      status: 200,
      includes: [
        route.title,
        'Canonical sources',
        `${productionOrigin}${route.path}`,
        ...(route.path === '/learn/01-first-outcome/let-plan-emerge'
          ? [
              'Give the outcome, not the workflow',
              'Assignment',
              'Scout',
              'Captain decision',
              'dependency',
              'One real example',
              'Check what became durable',
            ]
          : []),
      ],
      excludes: [
        'Fumadocs',
        ...(route.path === '/learn/01-first-outcome/let-plan-emerge'
          ? [
              'Wayfinder',
              '$1B',
              'PR #49',
              'v0.1.14',
              'v0.1.15',
              'openai-codex',
              '/home/agent',
              '15 durable Tasks',
              '43,638-character',
              '57 public sources',
              'AI Gateway repair Task',
              '8,721 SSE events',
              'five persistent Mates',
              'no competing pull request',
            ]
          : []),
      ],
    }),
  ),
  {
    path: '/robots.txt',
    status: 200,
    includes: [
      'OAI-SearchBot',
      'ChatGPT-User',
      'Claude-SearchBot',
      'Claude-User',
      'PerplexityBot',
      `${productionOrigin}/sitemap.xml`,
    ],
    excludes: [],
  },
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
    includes: [
      '## Documentation',
      '## Learn',
      'Upgrade without losing control',
      `${productionOrigin}/docs`,
      `${productionOrigin}/llms-full.txt`,
    ],
    excludes: ['Fumadocs UI', '](/'],
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

const parseOrigin = Effect.fn('agentos.website.parseSiteAuditOrigin')(
  function*(baseUrl: string | URL) {
    const origin = yield* Effect.try({
      try: () => new URL(baseUrl),
      catch: (cause) =>
        new SiteAuditError({
          code: 'configuration',
          message: `Invalid site audit base URL: ${String(baseUrl)}`,
          cause,
        }),
    });
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      return yield* new SiteAuditError({
        code: 'configuration',
        message: 'Site audit base URL must use HTTP or HTTPS.',
      });
    }
    return origin;
  },
);

const routeUrl = Effect.fn('agentos.website.makeSiteAuditRouteUrl')(
  function*(path: string, origin: URL) {
    return yield* Effect.try({
      try: () => new URL(path, origin),
      catch: (cause) =>
        new SiteAuditError({
          code: 'configuration',
          message: `Invalid site contract route: ${path}`,
          cause,
        }),
    });
  },
);

const redirectPath = Effect.fn('agentos.website.readSiteAuditRedirectPath')(
  function*(location: string | undefined, origin: URL) {
    if (location === undefined) return null;
    return yield* Effect.try({
      try: () => new URL(location, origin).pathname,
      catch: (cause) =>
        new SiteAuditError({
          code: 'configuration',
          message: `Invalid redirect location: ${location}`,
          cause,
        }),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
  },
);

export const makeLiveSiteAuditDependencies = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient;
  return {
    request: (url) =>
      Effect.scoped(
        Effect.gen(function*() {
          const response = yield* client.execute(HttpClientRequest.get(url));
          return {
            status: response.status,
            body: yield* response.text,
            location: response.headers.location,
          } satisfies SiteAuditResponse;
        }),
      ).pipe(
        Effect.timeout(30_000),
        Effect.mapError(
          (cause) =>
            new SiteAuditRequestError({
              message: `Request failed for ${url.toString()}`,
              cause,
            }),
        ),
      ),
  } satisfies SiteAuditDependencies;
}).pipe(Effect.withSpan('agentos.website.makeLiveSiteAuditDependencies'));

export const auditSite = Effect.fn('agentos.website.auditSite')(function*(
  baseUrl: string | URL,
  expectations: readonly RouteExpectation[] = routeExpectations,
  dependencies: SiteAuditDependencies,
) {
  const origin = yield* parseOrigin(baseUrl);
  const failures = yield* Effect.forEach(
    expectations,
    (expectation) =>
      Effect.gen(function*() {
        const url = yield* routeUrl(expectation.path, origin);
        const response = yield* dependencies.request(url).pipe(
          Effect.match({
            onFailure: (error) => ({
              path: expectation.path,
              requestFailure: error.message,
            }),
            onSuccess: (value) => ({
              path: expectation.path,
              response: value,
            }),
          }),
        );
        if ('requestFailure' in response) {
          return [
            {
              path: expectation.path,
              reason: `request failed: ${response.requestFailure}`,
            },
          ];
        }

        const routeFailures: Array<SiteAuditFailure> = [];
        if (response.response.status !== expectation.status) {
          routeFailures.push({
            path: expectation.path,
            reason: `expected status ${expectation.status}, received ${response.response.status}`,
          });
        }
        for (const required of expectation.includes) {
          if (!response.response.body.includes(required)) {
            routeFailures.push({
              path: expectation.path,
              reason: `missing required text: ${required}`,
            });
          }
        }
        for (const forbidden of expectation.excludes) {
          if (response.response.body.includes(forbidden)) {
            routeFailures.push({
              path: expectation.path,
              reason: `found forbidden text: ${forbidden}`,
            });
          }
        }
        if (expectation.location !== undefined) {
          const actualPath = yield* redirectPath(
            response.response.location,
            origin,
          );
          if (actualPath !== expectation.location) {
            routeFailures.push({
              path: expectation.path,
              reason: `expected location ${expectation.location}, received ${actualPath ?? 'none'}`,
            });
          }
        }
        return routeFailures;
      }),
    { concurrency: 8 },
  );
  return {
    checked: expectations.length,
    failures: failures.flat(),
  } satisfies SiteAuditResult;
});

const writeAuditLines = Effect.fn('agentos.website.writeSiteAuditLines')(
  function*(target: 'stderr' | 'stdout', lines: ReadonlyArray<string>) {
    if (lines.length === 0) return;
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${lines.join('\n')}\n`).pipe(
      Stream.run(target === 'stdout' ? stdio.stdout() : stdio.stderr()),
      Effect.mapError(
        (cause) =>
          new SiteAuditError({
            code: 'stdio',
            message: `Could not write site audit ${target}`,
            cause,
          }),
      ),
    );
  },
);

export const siteAuditMain = Effect.gen(function*() {
  const baseUrl = yield* Config.string('AGENTOS_SITE_BASE_URL').pipe(
    Config.withDefault('http://127.0.0.1:3100'),
  );
  const dependencies = yield* makeLiveSiteAuditDependencies;
  const result = yield* auditSite(baseUrl, routeExpectations, dependencies);
  if (result.failures.length > 0) {
    yield* writeAuditLines(
      'stderr',
      result.failures.map((failure) => `${failure.path}: ${failure.reason}`),
    );
    return yield* new SiteAuditError({
      code: 'contract',
      message: `Site audit found ${result.failures.length} contract failure${result.failures.length === 1 ? '' : 's'}.`,
      failures: result.failures.length,
    });
  }
  yield* writeAuditLines('stdout', [
    `Checked ${result.checked} public routes with no failures.`,
  ]);
});

if (import.meta.main) runWebsiteScript(siteAuditMain);
