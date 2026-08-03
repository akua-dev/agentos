import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import {
  Config,
  Effect,
  Layer,
  Option,
  Path,
  Runtime,
  Schema,
} from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { ChildProcess } from 'effect/unstable/process';
import { createServer } from 'node:net';

import {
  auditSite,
  makeLiveSiteAuditDependencies,
  routeExpectations,
  type RouteExpectation,
  type SiteAuditDependencies,
  type SiteAuditResponse,
} from './site-contract';

const renderedRoutePaths = new Set([
  '/does-not-exist',
  '/docs/does-not-exist',
  '/learn/does-not-exist',
]);
const realFleetEvidencePath = '/docs/concepts/progressive-planning-in-practice';
const simplifiedTutorialPath = '/learn/01-first-outcome/let-plan-emerge';

class RenderedSiteError extends Schema.TaggedErrorClass<RenderedSiteError>()(
  'RenderedSiteError',
  {
    code: Schema.Literals(['port', 'process', 'startup']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

function dependencies(
  responses: Readonly<
    Record<
      string,
      { readonly status: number; readonly body?: string; readonly location?: string }
    >
  >,
): SiteAuditDependencies {
  return {
    request: (url) => {
      const response = responses[url.pathname];
      return Effect.succeed({
        status: response?.status ?? 404,
        body: response?.body ?? '',
        ...(response?.location === undefined
          ? {}
          : { location: response.location }),
      });
    },
  };
}

/** One-way Node test adapter used only to reserve an ephemeral TCP port. */
const allocatePort = Effect.callback<number, RenderedSiteError>((resume) => {
  const server = createServer();
  server.once('error', (cause) =>
    resume(
      Effect.fail(
        new RenderedSiteError({
          code: 'port',
          message: 'Could not reserve a TCP port for the rendered-site test.',
          cause,
        }),
      ),
    ),
  );
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      resume(
        Effect.fail(
          new RenderedSiteError({
            code: 'port',
            message: 'The temporary server did not allocate a TCP port.',
          }),
        ),
      );
      return;
    }
    server.close((cause) =>
      resume(
        cause === undefined
          ? Effect.succeed(address.port)
          : Effect.fail(
              new RenderedSiteError({
                code: 'port',
                message: 'Could not release the temporary TCP port.',
                cause,
              }),
            ),
      ),
    );
  });
  return Effect.sync(() => server.close());
});

const acquireRenderedSite = Effect.gen(function*() {
  const configured = yield* Config.option(Config.string('AGENTOS_SITE_BASE_URL'));
  if (Option.isSome(configured)) return configured.value;

  const paths = yield* Path.Path;
  const appDirectory = yield* paths.fromFileUrl(new URL('..', import.meta.url));
  const port = yield* allocatePort;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = yield* ChildProcess.make(
    'bun',
    ['x', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: appDirectory,
      env: { NODE_ENV: 'development' },
      extendEnv: true,
      stdin: 'ignore',
      stderr: 'ignore',
      stdout: 'ignore',
    },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RenderedSiteError({
          code: 'process',
          message: 'Could not start the Next development server.',
          cause,
        }),
    ),
  );
  const live = yield* makeLiveSiteAuditDependencies;
  const waitUntilReady = Effect.gen(function*() {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const response = yield* live
        .request(new URL('/does-not-exist', baseUrl))
        .pipe(Effect.option);
      if (Option.isSome(response) && response.value.status === 404) return;
      yield* Effect.sleep(100);
    }
    return yield* new RenderedSiteError({
      code: 'startup',
      message: 'Timed out waiting for the Next development server.',
    });
  });
  yield* Effect.raceFirst(
    waitUntilReady,
    child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        new RenderedSiteError({
          code: 'startup',
          message: `Next development server exited early with code ${Number(exitCode)}.`,
        }),
      ),
    ),
  );
  return baseUrl;
});

describe('auditSite', () => {
  const expectation: RouteExpectation = {
    path: '/',
    status: 200,
    includes: ['AgentOS'],
    excludes: ['Fumadocs'],
  };

  it.effect('accepts a matching public response', () =>
    Effect.gen(function*() {
      const result = yield* auditSite(
        'https://agentos.example',
        [expectation],
        dependencies({ '/': { status: 200, body: '<h1>AgentOS</h1>' } }),
      );
      assert.deepStrictEqual(result, { checked: 1, failures: [] });
    }));

  it.effect('reports status, required text, and forbidden text failures', () =>
    Effect.gen(function*() {
      const result = yield* auditSite(
        'https://agentos.example',
        [expectation],
        dependencies({ '/': { status: 500, body: '<h1>Fumadocs</h1>' } }),
      );
      assert.deepStrictEqual(
        result.failures.map((failure) => failure.reason),
        [
          'expected status 200, received 500',
          'missing required text: AgentOS',
          'found forbidden text: Fumadocs',
        ],
      );
    }));

  it.effect('checks permanent redirects without following them', () =>
    Effect.gen(function*() {
      const redirect: RouteExpectation = {
        path: '/blog',
        status: 308,
        includes: [],
        excludes: [],
        location: '/learn',
      };
      const result = yield* auditSite(
        'https://agentos.example',
        [redirect],
        dependencies({
          '/blog': { status: 308, body: '', location: '/wrong' },
        }),
      );
      assert.deepStrictEqual(result.failures, [
        {
          path: '/blog',
          reason: 'expected location /learn, received /wrong',
        },
      ]);
    }));

  it('defines the complete public route contract', () => {
    const paths = routeExpectations.map((expectation) => expectation.path);
    assert.strictEqual(paths.length, 97);
    for (const path of [
      '/favicon.ico',
      '/icon.png',
      '/apple-icon.png',
      '/opengraph-image.png',
      '/robots.txt',
      '/docs/operate/supervise-steer',
      '/learn/03-stay-in-control/upgrade-without-losing-control',
      '/api/search?query=sovereign',
      '/does-not-exist',
      '/docs/does-not-exist',
      '/learn/does-not-exist',
      '/showcase',
    ]) {
      assert.include(paths, path);
    }
    assert.notInclude(paths, '/banner.png');
  });

  it('does not require Learn chapter structure on documentation routes', () => {
    const docsExpectation = routeExpectations.find(
      (candidate) => candidate.path === '/docs/start/get-started',
    );
    assert.deepStrictEqual(docsExpectation?.includes, [
      'Get started',
      'Canonical sources',
      'https://agentos.akua.dev/docs/start/get-started',
    ]);
    assert.notInclude(docsExpectation?.includes ?? [], 'What changes at this layer?');
  });
});

describe('rendered site contract', () => {
  it.live('audits rendered content and 404 metadata through Effect HTTP', () =>
      Effect.scoped(
        Effect.gen(function*() {
          const siteBaseUrl = yield* acquireRenderedSite;
          const live = yield* makeLiveSiteAuditDependencies;
          const notFoundExpectations = routeExpectations.filter((expectation) =>
            renderedRoutePaths.has(expectation.path),
          );
          assert.strictEqual(notFoundExpectations.length, renderedRoutePaths.size);
          assert.deepStrictEqual(
            yield* auditSite(siteBaseUrl, notFoundExpectations, live),
            { checked: renderedRoutePaths.size, failures: [] },
          );

          for (const path of [realFleetEvidencePath, simplifiedTutorialPath]) {
            const expectation = routeExpectations.find(
              (candidate) => candidate.path === path,
            );
            assert.isDefined(expectation);
            const rendered: RouteExpectation = {
              ...expectation,
              includes: expectation.includes.filter(
                (required) => required !== `https://agentos.akua.dev${path}`,
              ),
            };
            assert.deepStrictEqual(
              yield* auditSite(siteBaseUrl, [rendered], live),
              { checked: 1, failures: [] },
            );
          }

          for (const path of renderedRoutePaths) {
            const response: SiteAuditResponse = yield* live.request(
              new URL(path, siteBaseUrl),
            );
            const robots = Array.from(
              response.body.matchAll(
                /<meta name="robots" content="([^"]+)"\/?>/g,
              ),
              (match) => match[1],
            );
            assert.deepStrictEqual(robots, ['noindex'], path);
          }
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(BunServices.layer, FetchHttpClient.layer),
        ),
      ),
    120_000,
  );
});
