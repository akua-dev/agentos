import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertDeployableProvenance,
  createWorkerCommand,
  readGitSourceState,
  readProvenanceArtifact,
} from './worker-provenance';

type PublicationMode = 'preview' | 'production';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

function publicationMode(value: string | undefined): PublicationMode {
  if (value === 'preview' || value === 'production') return value;
  throw new Error('Publication mode must be preview or production.');
}

export function publishWorker(mode: PublicationMode): void {
  const provenance = readProvenanceArtifact(appDirectory);
  const gitSource = readGitSourceState(appDirectory);
  assertDeployableProvenance(provenance, gitSource);
  const args = createWorkerCommand(mode, provenance);

  console.log(
    `Publishing ${mode} Worker version from Git revision ${provenance.gitSha}.`,
  );
  run('bunx', [
    '--bun',
    'opennextjs-cloudflare',
    'populateCache',
    'remote',
  ]);
  run(
    'bunx',
    ['--bun', 'wrangler', ...args],
    mode === 'production'
      ? { ...process.env, OPEN_NEXT_DEPLOY: 'true' }
      : process.env,
  );
}

function run(
  command: string,
  args: readonly string[],
  environment = process.env,
): void {
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

if (import.meta.main) {
  try {
    publishWorker(publicationMode(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
