import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as publisher from './publish-worker';

describe('Worker publication subprocess', () => {
  it('retries a command whose first attempt never completes', async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'agentos-worker-publish-'),
    );
    const attemptPath = join(temporaryDirectory, 'attempts');
    const runCommandWithTimeoutRetry = (
      publisher as unknown as {
        runCommandWithTimeoutRetry?: (
          command: string,
          args: readonly string[],
          options: {
            attempts: number;
            timeoutMs: number;
          },
        ) => Promise<void>;
      }
    ).runCommandWithTimeoutRetry;

    try {
      expect(runCommandWithTimeoutRetry).toBeTypeOf('function');
      await runCommandWithTimeoutRetry!(
        process.execPath,
        [
          '-e',
          [
            'const fs = require("node:fs");',
            'const path = process.argv.at(-1);',
            'let attempt = 0;',
            'try { attempt = Number(fs.readFileSync(path, "utf8")); } catch {}',
            'attempt += 1;',
            'fs.writeFileSync(path, String(attempt));',
            'if (attempt === 1) setInterval(() => {}, 10_000);',
          ].join(''),
          attemptPath,
        ],
        {
          attempts: 2,
          timeoutMs: 100,
        },
      );
      expect(readFileSync(attemptPath, 'utf8')).toBe('2');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
