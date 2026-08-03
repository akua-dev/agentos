import { Effect, Path, Runtime, Schema } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

import { runWebsiteScript } from './script-runtime';

export class DocsLintProcessError extends
  Schema.TaggedErrorClass<DocsLintProcessError>()('DocsLintProcessError', {
    code: Schema.Literals(['path', 'process']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

export const runDocsLint = Effect.gen(function*() {
  const paths = yield* Path.Path;
  const appDirectory = yield* paths.fromFileUrl(new URL('..', import.meta.url)).pipe(
    Effect.mapError(
      (cause) =>
        new DocsLintProcessError({
          code: 'path',
          message: 'Could not resolve the AgentOS docs application directory',
          cause,
        }),
    ),
  );
  const exitCode = yield* Effect.scoped(
    Effect.gen(function*() {
      const child = yield* ChildProcess.make(
        'bun',
        ['./scripts/lint.worker.ts'],
        {
          cwd: appDirectory,
          env: { LINT: '1' },
          extendEnv: true,
          stdin: 'inherit',
          stderr: 'inherit',
          stdout: 'inherit',
        },
      );
      return Number(yield* child.exitCode);
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DocsLintProcessError({
          code: 'process',
          message: 'Could not run the AgentOS documentation lint worker',
          cause,
        }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new DocsLintProcessError({
      code: 'process',
      message: `AgentOS documentation lint exited with code ${exitCode}.`,
      exitCode,
    });
  }
});

if (import.meta.main) runWebsiteScript(runDocsLint);
