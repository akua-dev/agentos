import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readGitSourceState,
  resolveBuildProvenance,
  writeProvenanceArtifact,
} from './worker-provenance';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

function run(command: string, args: readonly string[], environment = process.env): void {
  const result = spawnSync(command, [...args], {
    cwd: appDirectory,
    env: environment,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}.`,
    );
  }
}

export function buildWorker(): void {
  const gitSource = readGitSourceState(appDirectory);
  const provenance = resolveBuildProvenance(process.env, gitSource);
  const buildEnvironment = {
    ...process.env,
    AGENTOS_BUILD_GIT_SHA: provenance.gitSha,
  };

  run(
    'bunx',
    ['opennextjs-cloudflare', 'build'],
    buildEnvironment,
  );
  writeProvenanceArtifact(appDirectory, provenance);
  run(process.execPath, ['./scripts/worker-size.ts']);

  const sourceState = provenance.sourceDirty ? 'dirty, not publishable' : 'clean';
  console.log(
    `Built Worker from Git revision ${provenance.gitSha} (${sourceState}).`,
  );
}

if (import.meta.main) {
  try {
    buildWorker();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
