import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { ValidateResult } from 'next-validate-link';

import {
  assertValidLinkResults,
  formatLinkValidationResults,
} from './lint-contract';

describe('docs link validation', () => {
  it.effect('accepts a clean validation result set', () =>
    assertValidLinkResults([]));

  it.effect('reports broken links as a typed failure', () => {
    const results: ReadonlyArray<ValidateResult> = [
      {
        file: 'content/docs/example.mdx',
        detected: [],
        errors: [
          {
            url: '/missing',
            line: 7,
            column: 3,
            reason: 'not-found',
          },
        ],
      },
    ];
    assert.include(formatLinkValidationResults(results), '/missing');
    return assertValidLinkResults(results).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => {
          assert.strictEqual(failure.code, 'invalid_links');
          assert.include(failure.message, '1 invalid link');
        }),
      ),
    );
  });
});
