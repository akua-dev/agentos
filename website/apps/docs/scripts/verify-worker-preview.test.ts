import { describe, expect, it } from 'vitest';
import {
  createPreviewUrl,
  verifyWorkerPreview,
  type PreviewVerificationOptions,
} from './verify-worker-preview';

const expectedSha = '1234567890abcdef1234567890abcdef12345678';
const productionSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function response(status: number, sha?: string): Response {
  return new Response('', {
    status,
    headers: sha ? { 'x-agentos-git-sha': sha } : undefined,
  });
}

describe('Cloudflare preview verification', () => {
  it('derives the public preview URL from the same branch alias as upload', () => {
    expect(
      createPreviewUrl(
        'chore/cloudflare-provenance',
        'agentos-site.example.workers.dev',
      ),
    ).toBe(
      'https://git-chore-cloudflare-provenance-agentos-site.example.workers.dev/',
    );
  });

  it('waits for the exact preview revision and proves production is different', async () => {
    const previewUrl = createPreviewUrl(
      'chore/cloudflare-provenance',
      'agentos-site.example.workers.dev',
    );
    const calls = new Map<string, number>();
    const options: PreviewVerificationOptions = {
      branch: 'chore/cloudflare-provenance',
      expectedSha,
      previewSuffix: 'agentos-site.example.workers.dev',
      productionUrl: 'https://agentos.example/',
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      fetch: async (input) => {
        const url = String(input);
        calls.set(url, (calls.get(url) ?? 0) + 1);
        if (url.startsWith('https://agentos.example/')) {
          return response(200, productionSha);
        }
        if (url.startsWith(previewUrl)) {
          return calls.get(url) === 1
            ? response(404)
            : response(200, expectedSha);
        }
        return response(404);
      },
    };

    await expect(verifyWorkerPreview(options)).resolves.toEqual({
      previewUrl,
      previewSha: expectedSha,
      productionSha,
    });
  });

  it('fails if a pull-request build reaches the production hostname', async () => {
    const options: PreviewVerificationOptions = {
      branch: 'chore/cloudflare-provenance',
      expectedSha,
      previewSuffix: 'agentos-site.example.workers.dev',
      productionUrl: 'https://agentos.example/',
      timeoutMs: 100,
      pollIntervalMs: 0,
      sleep: async () => {},
      fetch: async () => response(200, expectedSha),
    };

    await expect(verifyWorkerPreview(options)).rejects.toThrow(
      'Production is already serving the pull-request revision',
    );
  });
});
