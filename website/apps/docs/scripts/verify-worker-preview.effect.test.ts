import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Ref } from 'effect';

import {
  createPreviewUrl,
  verifyWorkerPreview,
  type PreviewRevision,
  type PreviewVerificationDependencies,
  type PreviewVerificationOptions,
} from './verify-worker-preview';

const expectedSha = '1234567890abcdef1234567890abcdef12345678';
const productionSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function dependencies(
  fetchRevision: (
    url: string,
    cacheKey: string,
  ) => Effect.Effect<PreviewRevision>,
): PreviewVerificationDependencies {
  return {
    fetchRevision,
    sleep: () => Effect.void,
  };
}

const baseOptions: PreviewVerificationOptions = {
  branch: 'chore/cloudflare-provenance',
  expectedSha,
  previewSuffix: 'agentos-site.example.workers.dev',
  productionUrl: 'https://agentos.example/',
  timeoutMs: 100,
  pollIntervalMs: 1,
};

describe('Cloudflare preview verification', () => {
  it.effect('derives the public preview URL from the same branch alias as upload', () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* createPreviewUrl(
          'chore/cloudflare-provenance',
          'agentos-site.example.workers.dev',
        ),
        'https://git-chore-cloudflare-provenance-agentos-site.example.workers.dev/',
      );
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect('waits for the exact preview revision and proves production is different', () =>
    Effect.gen(function*() {
      const previewUrl = yield* createPreviewUrl(
        baseOptions.branch,
        baseOptions.previewSuffix,
      );
      const previewCalls = yield* Ref.make(0);
      const result = yield* verifyWorkerPreview(
        baseOptions,
        dependencies((url) =>
          Effect.gen(function*() {
            if (url === baseOptions.productionUrl) {
              return { status: 200, sha: productionSha };
            }
            const call = yield* Ref.getAndUpdate(previewCalls, (value) => value + 1);
            return call === 0
              ? { status: 404, sha: null }
              : { status: 200, sha: expectedSha };
          }),
        ),
      );

      assert.deepStrictEqual(result, {
        previewUrl,
        previewSha: expectedSha,
        productionSha,
      });
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect('fails if a pull-request build reaches the production hostname', () =>
    verifyWorkerPreview(
      baseOptions,
      dependencies(() => Effect.succeed({ status: 200, sha: expectedSha })),
    ).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => {
          assert.include(
            failure.message,
            'Production is already serving the pull-request revision',
          );
        }),
      ),
      Effect.provide(BunServices.layer),
    ));

  it.effect('rejects malformed public Worker suffixes as typed failures', () =>
    createPreviewUrl(baseOptions.branch, 'https://workers.dev/path').pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => {
          assert.strictEqual(failure.code, 'configuration');
        }),
      ),
      Effect.provide(BunServices.layer),
    ));
});
