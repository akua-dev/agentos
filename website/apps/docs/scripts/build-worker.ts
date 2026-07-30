import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readGitSourceState,
  resolveBuildProvenance,
  writeProvenanceArtifact,
} from './worker-provenance';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

export function shouldVerifyWorkerSize(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.WORKERS_CI !== '1';
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

export async function buildWorker(): Promise<void> {
  const gitSource = readGitSourceState(appDirectory);
  const provenance = resolveBuildProvenance(process.env, gitSource);
  const buildEnvironment = {
    ...process.env,
    AGENTOS_BUILD_GIT_SHA: provenance.gitSha,
  };

  await run(
    process.execPath,
    ['x', 'opennextjs-cloudflare', 'build'],
    buildEnvironment,
  );
  writeProvenanceArtifact(appDirectory, provenance);
  if (shouldVerifyWorkerSize(process.env)) {
    await run(process.execPath, ['./scripts/worker-size.ts']);
  } else {
    console.log(
      'Workers Builds will enforce the compressed-size limit during the immediate upload; skipped the redundant Wrangler dry run.',
    );
  }

  const sourceState = provenance.sourceDirty ? 'dirty, not publishable' : 'clean';
  console.log(
    `Built Worker from Git revision ${provenance.gitSha} (${sourceState}).`,
  );
}

if (import.meta.main) {
  try {
    await buildWorker();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
