import {
  Cause,
  Effect,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/unstable/process';

import {
  assertDeployableProvenance,
  createWorkerCommand,
  loadBuildEnvironment,
  readGitSourceState,
  readProvenanceArtifact,
  type PublicationMode,
} from './worker-provenance';
import { runWebsiteScript } from './script-runtime';

const WRANGLER_UPLOAD_ATTEMPTS = 2;
const WRANGLER_UPLOAD_TIMEOUT_MS = 90_000;

export interface CommandOptions {
  readonly attempts?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export class WorkerPublicationError extends
  Schema.TaggedErrorClass<WorkerPublicationError>()('WorkerPublicationError', {
    code: Schema.Literals(['configuration', 'process', 'timeout']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

export function createWranglerProcessArguments(
  args: ReadonlyArray<string>,
): string[] {
  return ['x', 'wrangler', ...args];
}

export const publicationMode = Effect.fn('agentos.website.publicationMode')(
  function*(value: string | undefined) {
    if (value === 'preview' || value === 'production') return value;
    return yield* new WorkerPublicationError({
      code: 'configuration',
      message: 'Publication mode must be preview or production.',
    });
  },
);

const writeLine = Effect.fn('agentos.website.writePublishLine')(
  function*(line: string) {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout()));
  },
);

const runCommandAttempt = Effect.fn('agentos.website.runCommandAttempt')(
  function*(
    command: string,
    args: ReadonlyArray<string>,
    options: CommandOptions,
  ) {
    const commandEffect = Effect.scoped(
      Effect.gen(function*() {
        const child = yield* ChildProcess.make(command, args, {
          cwd: options.cwd,
          env: options.environment,
          extendEnv: options.environment !== undefined,
          stderr: 'inherit',
          stdout: 'inherit',
        });
        const exitCode = Number(yield* child.exitCode);
        if (exitCode !== 0) {
          return yield* new WorkerPublicationError({
            code: 'process',
            message: `${command} ${args.join(' ')} exited with code ${exitCode}.`,
            exitCode,
          });
        }
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkerPublicationError
          ? cause
          : new WorkerPublicationError({
              code: 'process',
              message: `Could not execute ${command} ${args.join(' ')}`,
              cause,
            }),
      ),
    );

    if (options.timeoutMs === undefined) return yield* commandEffect;
    return yield* commandEffect.pipe(
      Effect.timeout(options.timeoutMs),
      Effect.mapError((cause) =>
        Cause.isTimeoutError(cause)
          ? new WorkerPublicationError({
              code: 'timeout',
              message: `${command} ${args.join(' ')} timed out after ${options.timeoutMs} ms.`,
            })
          : cause,
      ),
    );
  },
);

export const runCommandWithTimeoutRetry = Effect.fn(
  'agentos.website.runCommandWithTimeoutRetry',
)(function*(
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
) {
  const attempts = options.attempts ?? 1;
  return yield* runCommandAttempt(command, args, options).pipe(
    Effect.retry({
      times: Math.max(0, attempts - 1),
      while: (error) => error.code === 'timeout',
    }),
  );
});

export const publishWorker = Effect.fn('agentos.website.publishWorker')(
  function*(mode: PublicationMode) {
    const paths = yield* Path.Path;
    const appDirectory = yield* paths.fromFileUrl(new URL('..', import.meta.url));
    const environment = yield* loadBuildEnvironment;
    const provenance = yield* readProvenanceArtifact(appDirectory);
    const gitSource = yield* readGitSourceState(appDirectory, environment);
    yield* assertDeployableProvenance(provenance, gitSource);
    const args = yield* createWorkerCommand(mode, provenance);

    yield* writeLine(
      `Publishing ${mode} Worker version from Git revision ${provenance.gitSha}.`,
    );
    yield* runCommandWithTimeoutRetry(
      'bun',
      ['x', '--bun', 'opennextjs-cloudflare', 'populateCache', 'remote'],
      { cwd: appDirectory },
    );
    yield* runCommandWithTimeoutRetry(
      'bun',
      createWranglerProcessArguments(args),
      {
        attempts: WRANGLER_UPLOAD_ATTEMPTS,
        cwd: appDirectory,
        environment:
          mode === 'production' ? { OPEN_NEXT_DEPLOY: 'true' } : undefined,
        timeoutMs: WRANGLER_UPLOAD_TIMEOUT_MS,
      },
    );
  },
);

export const publishWorkerMain = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  yield* publishWorker(yield* publicationMode(args[0]));
});

if (import.meta.main) runWebsiteScript(publishWorkerMain);
