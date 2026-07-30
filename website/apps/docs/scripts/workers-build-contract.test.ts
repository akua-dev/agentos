import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Workers Builds dependency contract', () => {
  it('keeps the shared Bun lockfile readable by the Workers Builds image', () => {
    const lockfile = readFileSync(
      new URL('../../../../bun.lock', import.meta.url),
      'utf8',
    );
    const lockfileVersion = lockfile.match(/"lockfileVersion":\s*(\d+)/)?.[1];

    expect(lockfileVersion).toBe('1');
  });
});
