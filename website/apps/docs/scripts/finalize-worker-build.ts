import { fileURLToPath } from 'node:url';
import {
  readGitSourceState,
  resolveBuildProvenance,
  writeProvenanceArtifact,
} from './worker-provenance';
import { verifyWorkerSize } from './worker-size';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

export function shouldVerifyWorkerSize(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.WORKERS_CI !== '1';
}

export async function finalizeWorkerBuild(): Promise<void> {
  const gitSource = readGitSourceState(appDirectory);
  const provenance = resolveBuildProvenance(process.env, gitSource);

  if (shouldVerifyWorkerSize(process.env)) {
    await verifyWorkerSize();
  } else {
    console.log(
      'Workers Builds will enforce the compressed-size limit during the immediate upload; skipped the redundant Wrangler dry run.',
    );
  }

  writeProvenanceArtifact(appDirectory, provenance);
  const sourceState = provenance.sourceDirty ? 'dirty, not publishable' : 'clean';
  console.log(
    `Finalized Worker from Git revision ${provenance.gitSha} (${sourceState}).`,
  );
}

if (import.meta.main) {
  try {
    await finalizeWorkerBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
