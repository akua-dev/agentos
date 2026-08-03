import {
  Config,
  Effect,
  FileSystem,
  Option,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { runWebsiteScript } from './script-runtime';
import { createPreviewAlias } from './worker-provenance';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const PROVENANCE_HEADER = 'x-agentos-git-sha';
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const PRODUCTION_URL = 'https://agentos.akua.dev/';

export interface PreviewVerificationOptions {
  readonly branch: string;
  readonly expectedSha: string;
  readonly previewSuffix: string;
  readonly productionUrl: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface PreviewRevision {
  readonly status: number;
  readonly sha: string | null;
}

export interface PreviewVerificationDependencies {
  readonly fetchRevision: (
    url: string,
    cacheKey: string,
  ) => Effect.Effect<PreviewRevision, PreviewVerificationError>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

export interface PreviewVerificationResult {
  readonly previewUrl: string;
  readonly previewSha: string;
  readonly productionSha: string | null;
}

export class PreviewVerificationError extends
  Schema.TaggedErrorClass<PreviewVerificationError>()(
    'PreviewVerificationError',
    {
      code: Schema.Literals([
        'configuration',
        'filesystem',
        'http',
        'preview',
        'production',
        'stdio',
      ]),
      message: Schema.String,
      cause: Schema.optional(Schema.Defect()),
    },
  ) {
  override readonly [Runtime.errorExitCode] = 1;
}

const PreviewVerificationConfig = Config.all({
  branch: Config.string('AGENTOS_PREVIEW_BRANCH'),
  expectedSha: Config.string('AGENTOS_EXPECTED_GIT_SHA'),
  previewSuffix: Config.string('AGENTOS_WORKERS_PREVIEW_SUFFIX'),
  productionUrl: Config.string('AGENTOS_PRODUCTION_URL').pipe(
    Config.withDefault(PRODUCTION_URL),
  ),
  summaryPath: Config.option(Config.string('GITHUB_STEP_SUMMARY')),
});

const normalizeExpectedSha = Effect.fn(
  'agentos.website.normalizeExpectedPreviewSha',
)(function*(value: string) {
  const sha = value.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(sha)) {
    return yield* new PreviewVerificationError({
      code: 'configuration',
      message: 'Expected preview revision must be a full 40-character Git SHA.',
    });
  }
  return sha;
});

function normalizeObservedSha(value: string | undefined): string | null {
  if (value === undefined) return null;
  const sha = value.trim().toLowerCase();
  return FULL_GIT_SHA.test(sha) ? sha : null;
}

const normalizeTiming = Effect.fn('agentos.website.normalizePreviewTiming')(
  function*(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return yield* new PreviewVerificationError({
        code: 'configuration',
        message: `${name} must be a non-negative safe integer.`,
      });
    }
    return value;
  },
);

export const createPreviewUrl = Effect.fn('agentos.website.createPreviewUrl')(
  function*(branch: string, previewSuffix: string) {
    const suffix = previewSuffix.trim().toLowerCase();
    if (
      suffix.length === 0 ||
      suffix.includes('/') ||
      suffix.includes(':') ||
      !/^[a-z0-9.-]+\.workers\.dev$/.test(suffix)
    ) {
      return yield* new PreviewVerificationError({
        code: 'configuration',
        message:
          'Preview suffix must be the public Worker hostname ending in workers.dev, without a protocol or path.',
      });
    }
    return `https://${yield* createPreviewAlias(branch)}-${suffix}/`;
  },
);

export const makeLivePreviewVerificationDependencies = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient;
  return {
    fetchRevision: (url, cacheKey) => {
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setUrlParam('agentos_git_sha', cacheKey),
        HttpClientRequest.setHeader('cache-control', 'no-cache'),
      );
      return Effect.scoped(client.execute(request)).pipe(
        Effect.timeout(15_000),
        Effect.map(
          (response): PreviewRevision => ({
            status: response.status,
            sha: normalizeObservedSha(response.headers[PROVENANCE_HEADER]),
          }),
        ),
        Effect.mapError(
          (cause) =>
            new PreviewVerificationError({
              code: 'http',
              message: `Could not read Worker revision from ${url}`,
              cause,
            }),
        ),
      );
    },
    sleep: (milliseconds) => Effect.sleep(milliseconds),
  } satisfies PreviewVerificationDependencies;
}).pipe(Effect.withSpan('agentos.website.makePreviewVerificationDependencies'));

export const verifyWorkerPreview = Effect.fn(
  'agentos.website.verifyWorkerPreview',
)(function*(
  options: PreviewVerificationOptions,
  dependencies: PreviewVerificationDependencies,
) {
  const expectedSha = yield* normalizeExpectedSha(options.expectedSha);
  const previewUrl = yield* createPreviewUrl(
    options.branch,
    options.previewSuffix,
  );
  const timeoutMs = yield* normalizeTiming(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'Preview timeout',
  );
  const pollIntervalMs = yield* normalizeTiming(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'Preview poll interval',
  );
  const pollingStep = Math.max(1, pollIntervalMs);
  const attempts = Math.max(1, Math.floor(timeoutMs / pollingStep) + 1);
  let lastPreviewStatus = 0;
  let lastPreviewSha: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const preview = yield* dependencies
      .fetchRevision(previewUrl, expectedSha)
      .pipe(
        Effect.catch(() => Effect.succeed({ status: 0, sha: null })),
      );
    lastPreviewStatus = preview.status;
    lastPreviewSha = preview.sha;
    if (preview.status === 200 && preview.sha === expectedSha) break;
    if (attempt + 1 < attempts) yield* dependencies.sleep(pollIntervalMs);
  }

  if (lastPreviewStatus !== 200 || lastPreviewSha !== expectedSha) {
    return yield* new PreviewVerificationError({
      code: 'preview',
      message: `Preview did not serve Git revision ${expectedSha} before the timeout (status ${lastPreviewStatus || 'unreachable'}, revision ${lastPreviewSha ?? 'missing'}).`,
    });
  }

  const production = yield* dependencies.fetchRevision(
    options.productionUrl,
    expectedSha,
  );
  if (production.status !== 200) {
    return yield* new PreviewVerificationError({
      code: 'production',
      message: `Production returned HTTP ${production.status}; preview isolation could not be verified.`,
    });
  }
  if (production.sha === expectedSha) {
    return yield* new PreviewVerificationError({
      code: 'production',
      message: `Production is already serving the pull-request revision ${expectedSha}.`,
    });
  }

  return {
    previewUrl,
    previewSha: lastPreviewSha,
    productionSha: production.sha,
  } satisfies PreviewVerificationResult;
});

export const writeGitHubSummary = Effect.fn(
  'agentos.website.writePreviewGitHubSummary',
)(function*(
  summaryPath: Option.Option<string>,
  result: PreviewVerificationResult,
) {
  if (Option.isNone(summaryPath)) return;
  const productionRevision = result.productionSha
    ? `\`${result.productionSha}\``
    : 'a legacy pre-provenance version';
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .writeFileString(
      summaryPath.value,
      [
        '### Cloudflare Worker preview',
        '',
        `- Preview: [${result.previewUrl}](${result.previewUrl})`,
        `- Preview Git revision: \`${result.previewSha}\``,
        `- Production remained on ${productionRevision}.`,
        '',
      ].join('\n'),
      { flag: 'a' },
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PreviewVerificationError({
            code: 'filesystem',
            message: 'Could not append the Worker preview GitHub summary',
            cause,
          }),
      ),
    );
});

const writeVerificationLine = Effect.fn(
  'agentos.website.writePreviewVerificationLine',
)(function*(result: PreviewVerificationResult) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(
    `Verified ${result.previewUrl} at ${result.previewSha}; production remains distinct.\n`,
  ).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError(
      (cause) =>
        new PreviewVerificationError({
          code: 'stdio',
          message: 'Could not write the Worker preview verification result',
          cause,
        }),
    ),
  );
});

export const verifyWorkerPreviewMain = Effect.gen(function*() {
  const config = yield* PreviewVerificationConfig;
  const dependencies = yield* makeLivePreviewVerificationDependencies;
  const result = yield* verifyWorkerPreview(
    {
      branch: config.branch,
      expectedSha: config.expectedSha,
      previewSuffix: config.previewSuffix,
      productionUrl: config.productionUrl,
    },
    dependencies,
  );
  yield* writeGitHubSummary(config.summaryPath, result);
  yield* writeVerificationLine(result);
});

if (import.meta.main) runWebsiteScript(verifyWorkerPreviewMain);
