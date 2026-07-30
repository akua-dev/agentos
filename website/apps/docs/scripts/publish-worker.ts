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
const WRANGLER_UPLOAD_ATTEMPTS = 2;
const WRANGLER_UPLOAD_TIMEOUT_MS = 90_000;

interface CommandOptions {
  attempts?: number;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

class CommandTimeoutError extends Error {}

export function createWranglerProcessArguments(
  args: readonly string[],
): string[] {
  return ['x', 'wrangler', ...args];
}

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
  await runCommandWithTimeoutRetry(
    process.execPath,
    [
      'x',
      '--bun',
      'opennextjs-cloudflare',
      'populateCache',
      'remote',
    ],
  );
  await runCommandWithTimeoutRetry(
    process.execPath,
    createWranglerProcessArguments(args),
    {
      attempts: WRANGLER_UPLOAD_ATTEMPTS,
      environment:
        mode === 'production'
          ? { ...process.env, OPEN_NEXT_DEPLOY: 'true' }
          : process.env,
      timeoutMs: WRANGLER_UPLOAD_TIMEOUT_MS,
    },
  );
}

async function runCommandAttempt(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const subprocess = spawn(command, [...args], {
      cwd: appDirectory,
      env: environment,
      stdio: 'inherit',
    });

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        subprocess.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          subprocess.kill('SIGKILL');
        }, 5_000);
      }, timeoutMs);
    }

    subprocess.once('error', (error) => {
      clearTimers();
      reject(
        timedOut
          ? new CommandTimeoutError(
              `${command} ${args.join(' ')} timed out after ${timeoutMs} ms.`,
            )
          : error,
      );
    });
    subprocess.once('close', (exitCode, signal) => {
      clearTimers();
      if (timedOut) {
        reject(
          new CommandTimeoutError(
            `${command} ${args.join(' ')} timed out after ${timeoutMs} ms.`,
          ),
        );
        return;
      }
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

export async function runCommandWithTimeoutRetry(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 1;
  const environment = options.environment ?? process.env;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runCommandAttempt(
        command,
        args,
        environment,
        options.timeoutMs,
      );
      return;
    } catch (error) {
      if (!(error instanceof CommandTimeoutError) || attempt === attempts) {
        throw error;
      }
      console.warn(
        `${error.message} Retrying attempt ${attempt + 1} of ${attempts}.`,
      );
    }
  }
}

if (import.meta.main) {
  try {
    await publishWorker(publicationMode(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
