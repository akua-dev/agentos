import { appendFileSync } from 'node:fs';
import { createPreviewAlias } from './worker-provenance';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const PROVENANCE_HEADER = 'x-agentos-git-sha';

export interface PreviewVerificationOptions {
  branch: string;
  expectedSha: string;
  previewSuffix: string;
  productionUrl: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface PreviewVerificationResult {
  previewUrl: string;
  previewSha: string;
  productionSha: string | null;
}

function normalizeExpectedSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error('Expected preview revision must be a full 40-character Git SHA.');
  }
  return sha;
}

function normalizeObservedSha(value: string | null): string | null {
  if (!value) return null;
  const sha = value.trim().toLowerCase();
  return FULL_GIT_SHA.test(sha) ? sha : null;
}

export function createPreviewUrl(branch: string, previewSuffix: string): string {
  const suffix = previewSuffix.trim().toLowerCase();
  if (
    !suffix ||
    suffix.includes('/') ||
    suffix.includes(':') ||
    !/^[a-z0-9.-]+\.workers\.dev$/.test(suffix)
  ) {
    throw new Error(
      'Preview suffix must be the public Worker hostname ending in workers.dev, without a protocol or path.',
    );
  }
  return `https://${createPreviewAlias(branch)}-${suffix}/`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchRevision(
  fetchImplementation: typeof fetch,
  url: string,
  cacheKey: string,
): Promise<{ status: number; sha: string | null }> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('agentos_git_sha', cacheKey);
  const response = await fetchImplementation(requestUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'cache-control': 'no-cache',
    },
  });
  return {
    status: response.status,
    sha: normalizeObservedSha(response.headers.get(PROVENANCE_HEADER)),
  };
}

export async function verifyWorkerPreview(
  options: PreviewVerificationOptions,
): Promise<PreviewVerificationResult> {
  const expectedSha = normalizeExpectedSha(options.expectedSha);
  const previewUrl = createPreviewUrl(options.branch, options.previewSuffix);
  const fetchImplementation = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastPreviewStatus = 0;
  let lastPreviewSha: string | null = null;

  while (Date.now() <= deadline) {
    try {
      const preview = await fetchRevision(
        fetchImplementation,
        previewUrl,
        expectedSha,
      );
      lastPreviewStatus = preview.status;
      lastPreviewSha = preview.sha;
      if (preview.status === 200 && preview.sha === expectedSha) break;
    } catch {
      lastPreviewStatus = 0;
      lastPreviewSha = null;
    }

    if (Date.now() + pollIntervalMs > deadline) break;
    await wait(pollIntervalMs);
  }

  if (lastPreviewStatus !== 200 || lastPreviewSha !== expectedSha) {
    throw new Error(
      `Preview did not serve Git revision ${expectedSha} before the timeout (status ${lastPreviewStatus || 'unreachable'}, revision ${lastPreviewSha ?? 'missing'}).`,
    );
  }

  const production = await fetchRevision(
    fetchImplementation,
    options.productionUrl,
    expectedSha,
  );
  if (production.status !== 200) {
    throw new Error(
      `Production returned HTTP ${production.status}; preview isolation could not be verified.`,
    );
  }
  if (production.sha === expectedSha) {
    throw new Error(
      `Production is already serving the pull-request revision ${expectedSha}.`,
    );
  }

  return {
    previewUrl,
    previewSha: lastPreviewSha,
    productionSha: production.sha,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeGitHubSummary(result: PreviewVerificationResult): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const productionRevision = result.productionSha
    ? `\`${result.productionSha}\``
    : 'a legacy pre-provenance version';

  appendFileSync(
    summaryPath,
    [
      '### Cloudflare Worker preview',
      '',
      `- Preview: [${result.previewUrl}](${result.previewUrl})`,
      `- Preview Git revision: \`${result.previewSha}\``,
      `- Production remained on ${productionRevision}.`,
      '',
    ].join('\n'),
    'utf8',
  );
}

if (import.meta.main) {
  try {
    const result = await verifyWorkerPreview({
      branch: requiredEnvironment('AGENTOS_PREVIEW_BRANCH'),
      expectedSha: requiredEnvironment('AGENTOS_EXPECTED_GIT_SHA'),
      previewSuffix: requiredEnvironment('AGENTOS_WORKERS_PREVIEW_SUFFIX'),
      productionUrl:
        process.env.AGENTOS_PRODUCTION_URL?.trim() ||
        'https://agentos.akua.dev/',
    });
    writeGitHubSummary(result);
    console.log(
      `Verified ${result.previewUrl} at ${result.previewSha}; production remains distinct.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
