import { Effect, Path, Runtime, Schema, Stdio, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

import { runWebsiteScript } from './script-runtime';

const FREE_PLAN_LIMIT_KIB = 3 * 1024;

export class WorkerSizeError extends Schema.TaggedErrorClass<WorkerSizeError>()(
  'WorkerSizeError',
  {
    code: Schema.Literals(['invalid_output', 'limit_exceeded', 'process', 'stdio']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

export const parseCompressedWorkerSize = Effect.fn(
  'agentos.website.parseCompressedWorkerSize',
)(function*(output: string) {
  const compressedSize = output.match(
    /Total Upload:\s+[\d.]+\s+KiB\s+\/\s+gzip:\s+([\d.]+)\s+KiB/,
  )?.[1];
  const parsed = compressedSize === undefined ? Number.NaN : Number(compressedSize);

  if (!Number.isFinite(parsed)) {
    return yield* new WorkerSizeError({
      code: 'invalid_output',
      message: 'Wrangler did not report a compressed Worker upload size.',
    });
  }

  return parsed;
});

export const assertWorkerFitsFreePlan = Effect.fn(
  'agentos.website.assertWorkerFitsFreePlan',
)(function*(compressedSizeKiB: number) {
  if (compressedSizeKiB > FREE_PLAN_LIMIT_KIB) {
    return yield* new WorkerSizeError({
      code: 'limit_exceeded',
      message: `Worker bundle is ${compressedSizeKiB.toFixed(2)} KiB compressed, above the 3 MiB Cloudflare Workers Free limit.`,
    });
  }
});

const writeOutput = Effect.fn('agentos.website.writeWorkerSizeOutput')(
  function*(target: 'stderr' | 'stdout', value: string) {
    if (value.length === 0) return;
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(value).pipe(
      Stream.run(target === 'stdout' ? stdio.stdout() : stdio.stderr()),
      Effect.mapError(
        (cause) =>
          new WorkerSizeError({
            code: 'stdio',
            message: `Could not write Worker size ${target}`,
            cause,
          }),
      ),
    );
  },
);

export const verifyWorkerSize = Effect.fn('agentos.website.verifyWorkerSize')(
  function*() {
    const paths = yield* Path.Path;
    const appDirectory = yield* paths.fromFileUrl(new URL('..', import.meta.url)).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerSizeError({
            code: 'process',
            message: 'Could not resolve the website directory',
            cause,
          }),
      ),
    );
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const child = yield* ChildProcess.make(
          'bun',
          ['x', '--bun', 'wrangler', 'deploy', '--dry-run'],
          {
            cwd: appDirectory,
            stderr: 'pipe',
            stdout: 'pipe',
          },
        );
        const [exitCode, stderr, stdout] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 'unbounded' },
        );
        return { exitCode, stderr, stdout };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerSizeError({
            code: 'process',
            message: 'Could not execute the Wrangler dry run',
            cause,
          }),
      ),
    );

    yield* Effect.all([
      writeOutput('stdout', result.stdout),
      writeOutput('stderr', result.stderr),
    ]);
    if (result.exitCode !== 0) {
      return yield* new WorkerSizeError({
        code: 'process',
        message: `Wrangler dry-run exited with code ${result.exitCode}.`,
        exitCode: result.exitCode,
      });
    }

    const compressedSizeKiB = yield* parseCompressedWorkerSize(
      `${result.stdout}\n${result.stderr}`,
    );
    yield* assertWorkerFitsFreePlan(compressedSizeKiB);
    return compressedSizeKiB;
  },
);

export const workerSizeMain = Effect.gen(function*() {
  const compressedSizeKiB = yield* verifyWorkerSize();
  yield* writeOutput(
    'stdout',
    `Verified Worker bundle at ${compressedSizeKiB.toFixed(2)} KiB compressed.\n`,
  );
});

if (import.meta.main) runWebsiteScript(workerSizeMain);
