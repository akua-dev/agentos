import { postInstall } from 'fumadocs-mdx/next';
import mdx from 'fumadocs-mdx/rolldown';
import { Effect, Runtime, Schema, Stdio } from 'effect';
import { unrun } from 'unrun';

import { runWebsiteScript } from './script-runtime';

interface DocsLintModule {
  readonly checkLinks: Effect.Effect<void, unknown, Stdio.Stdio>;
}

export class DocsLintWorkerError extends
  Schema.TaggedErrorClass<DocsLintWorkerError>()('DocsLintWorkerError', {
    code: Schema.Literals(['generation', 'loading', 'plugin']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

function workerPromise<A>(
  code: DocsLintWorkerError['code'],
  message: string,
  operation: () => Promise<A>,
) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new DocsLintWorkerError({ code, message, cause }),
  });
}

export const docsLintWorker = Effect.gen(function*() {
  yield* workerPromise(
    'generation',
    'Could not generate Fumadocs collections for link validation',
    () => postInstall(),
  );
  const sourceConfig = yield* workerPromise(
    'loading',
    'Could not load the Fumadocs source configuration',
    () => import('../source.config.ts'),
  );
  const plugins = yield* workerPromise(
    'plugin',
    'Could not initialize the Fumadocs Rolldown plugin',
    () => mdx(sourceConfig),
  );
  const loaded = yield* workerPromise(
    'loading',
    'Could not load the AgentOS documentation lint program',
    () =>
      unrun<DocsLintModule>({
        path: './scripts/lint.ts',
        inputOptions: { plugins },
      }),
  );
  return yield* loaded.module.checkLinks;
}).pipe(Effect.withSpan('agentos.website.docsLintWorker'));

if (import.meta.main) runWebsiteScript(docsLintWorker);
