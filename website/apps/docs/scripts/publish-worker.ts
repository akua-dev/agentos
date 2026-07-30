import { spawn } from 'node:child_process';
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

export async function publishWorker(mode: PublicationMode): Promise<void> {
  const provenance = readProvenanceArtifact(appDirectory);
  const gitSource = readGitSourceState(appDirectory);
  assertDeployableProvenance(provenance, gitSource);
  const args = createWorkerCommand(mode, provenance);

  console.log(
    `Publishing ${mode} Worker version from Git revision ${provenance.gitSha}.`,
  );
  await run(process.execPath, [
    'x',
    '--bun',
    'opennextjs-cloudflare',
    'populateCache',
    'remote',
  ]);
  await run(
    process.execPath,
    ['x', '--bun', 'wrangler', ...args],
    mode === 'production'
      ? { ...process.env, OPEN_NEXT_DEPLOY: 'true' }
      : process.env,
  );
}

async function run(
  command: string,
  args: readonly string[],
  environment = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const subprocess = spawn(command, [...args], {
      cwd: appDirectory,
      env: environment,
      stdio: 'inherit',
    });
    subprocess.once('error', reject);
    subprocess.once('close', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${exitCode === null ? `signal ${signal ?? 'unknown'}` : `code ${exitCode}`}.`,
        ),
      );
    });
  });
}

if (import.meta.main) {
  try {
    await publishWorker(publicationMode(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
