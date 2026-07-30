import { describe, expect, it } from 'vitest';
import {
  assertWorkerFitsFreePlan,
  parseCompressedWorkerSize,
} from './worker-size';
import { shouldVerifyWorkerSize } from './finalize-worker-build';

describe('Cloudflare Worker size contract', () => {
  it('reads the compressed upload size reported by Wrangler', () => {
    expect(
      parseCompressedWorkerSize(
        'Total Upload: 13833.20 KiB / gzip: 2295.89 KiB',
      ),
    ).toBe(2295.89);
  });

  it('accepts a Worker within the free-plan upload limit', () => {
    expect(() => assertWorkerFitsFreePlan(3072)).not.toThrow();
  });

  it('rejects a Worker over the free-plan upload limit', () => {
    expect(() => assertWorkerFitsFreePlan(3072.01)).toThrow(
      /3 MiB Cloudflare Workers Free limit/,
    );
  });

  it('leaves the redundant dry run to CI when Workers Builds will upload next', () => {
    expect(shouldVerifyWorkerSize({ WORKERS_CI: '1' })).toBe(false);
    expect(shouldVerifyWorkerSize({ CI: 'true' })).toBe(true);
    expect(shouldVerifyWorkerSize({})).toBe(true);
  });
});
