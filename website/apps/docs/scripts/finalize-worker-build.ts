import { Config, Effect, Option, Path, Stdio, Stream } from 'effect';

import {
  loadBuildEnvironment,
  readGitSourceState,
  resolveBuildProvenance,
  writeProvenanceArtifact,
} from './worker-provenance';
import { verifyWorkerSize } from './worker-size';
import { runWebsiteScript } from './script-runtime';

export function shouldVerifyWorkerSize(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.WORKERS_CI !== '1';
}

const writeLine = Effect.fn('agentos.website.writeFinalizeLine')(
  function*(line: string) {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout()));
  },
);

export const finalizeWorkerBuild = Effect.gen(function*() {
  const paths = yield* Path.Path;
  const appDirectory = yield* paths.fromFileUrl(new URL('..', import.meta.url));
  const environment = yield* loadBuildEnvironment;
  const workersCi = yield* Config.option(Config.string('WORKERS_CI'));
  const gitSource = yield* readGitSourceState(appDirectory, environment);
  const provenance = yield* resolveBuildProvenance(environment, gitSource);

  if (
    shouldVerifyWorkerSize({
      WORKERS_CI: Option.getOrUndefined(workersCi),
    })
  ) {
    yield* verifyWorkerSize();
  } else {
    yield* writeLine(
      'Workers Builds will enforce the compressed-size limit during the immediate upload; skipped the redundant Wrangler dry run.',
    );
  }

  yield* writeProvenanceArtifact(appDirectory, provenance);
  const sourceState = provenance.sourceDirty ? 'dirty, not publishable' : 'clean';
  yield* writeLine(
    `Finalized Worker from Git revision ${provenance.gitSha} (${sourceState}).`,
  );
});

if (import.meta.main) runWebsiteScript(finalizeWorkerBuild);
