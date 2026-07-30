import { spawnSync } from 'node:child_process';

const FREE_PLAN_LIMIT_KIB = 3 * 1024;

export function parseCompressedWorkerSize(output: string): number {
  const compressedSize = output.match(
    /Total Upload:\s+[\d.]+\s+KiB\s+\/\s+gzip:\s+([\d.]+)\s+KiB/,
  )?.[1];

  if (!compressedSize) {
    throw new Error('Wrangler did not report a compressed Worker upload size.');
  }

  return Number(compressedSize);
}

export function assertWorkerFitsFreePlan(compressedSizeKiB: number): void {
  if (compressedSizeKiB > FREE_PLAN_LIMIT_KIB) {
    throw new Error(
      `Worker bundle is ${compressedSizeKiB.toFixed(2)} KiB compressed, above the 3 MiB Cloudflare Workers Free limit.`,
    );
  }
}

export async function verifyWorkerSize(): Promise<number> {
  const wrangler = spawnSync(
    process.execPath,
    ['x', '--bun', 'wrangler', 'deploy', '--dry-run'],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    },
  );
  const stdout = wrangler.stdout;
  const stderr = wrangler.stderr;
  const output = `${stdout}\n${stderr}`;

  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (wrangler.status !== 0) {
    throw new Error(`Wrangler dry-run exited with code ${wrangler.status}.`);
  }

  const compressedSizeKiB = parseCompressedWorkerSize(output);
  assertWorkerFitsFreePlan(compressedSizeKiB);
  return compressedSizeKiB;
}

if (import.meta.main) {
  try {
    const compressedSizeKiB = await verifyWorkerSize();
    console.log(
      `Verified Worker bundle at ${compressedSizeKiB.toFixed(2)} KiB compressed.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
