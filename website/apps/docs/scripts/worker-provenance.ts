import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_DNS_LABEL_LENGTH = 63;
const WORKER_NAME = 'agentos-site';
const PROVENANCE_FILENAME = 'agentos-provenance.json';

export interface GitSourceState {
  sha: string;
  branch: string;
  dirty: boolean;
}

export interface WorkerProvenance {
  schemaVersion: 1;
  gitSha: string;
  gitBranch: string;
  sourceDirty: boolean;
}

type BuildEnvironment = Readonly<Record<string, string | undefined>>;
type PublicationMode = 'preview' | 'production';

function normalizeGitSha(value: string, source: string): string {
  const sha = value.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error(`${source} must be a full 40-character Git SHA.`);
  }
  return sha;
}

function normalizeGitBranch(value: string, source: string): string {
  const branch = value.trim();
  if (!branch || /[\0\r\n]/.test(branch)) {
    throw new Error(`${source} must be a non-empty Git branch without control characters.`);
  }
  return branch;
}

function runGit(cwd: string, args: readonly string[], allowEmpty = false): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`,
    );
  }

  const output = result.stdout.trim();
  if (!allowEmpty && !output) {
    throw new Error(`git ${args.join(' ')} returned no value.`);
  }
  return output;
}

export function readGitSourceState(
  cwd: string,
  environment: BuildEnvironment = process.env,
): GitSourceState {
  const sha = normalizeGitSha(runGit(cwd, ['rev-parse', 'HEAD']), 'Git HEAD');
  const detectedBranch = runGit(cwd, ['branch', '--show-current'], true);
  const branch = normalizeGitBranch(
    detectedBranch ||
      environment.WORKERS_CI_BRANCH ||
      environment.GITHUB_HEAD_REF ||
      environment.GITHUB_REF_NAME ||
      'detached',
    'Git branch',
  );
  const dirty =
    runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no'], true) !== '';

  return { sha, branch, dirty };
}

export function resolveBuildProvenance(
  environment: BuildEnvironment,
  gitSource: GitSourceState,
): WorkerProvenance {
  const gitSha = normalizeGitSha(
    environment.WORKERS_CI_COMMIT_SHA ?? gitSource.sha,
    environment.WORKERS_CI_COMMIT_SHA
      ? 'WORKERS_CI_COMMIT_SHA'
      : 'Git revision',
  );
  const checkoutSha = normalizeGitSha(gitSource.sha, 'Git HEAD');

  if (gitSha !== checkoutSha) {
    throw new Error(
      `Cloudflare build revision ${gitSha} does not match the checked-out Git revision ${checkoutSha}.`,
    );
  }

  return {
    schemaVersion: 1,
    gitSha,
    gitBranch: normalizeGitBranch(
      environment.WORKERS_CI_BRANCH ?? gitSource.branch,
      environment.WORKERS_CI_BRANCH ? 'WORKERS_CI_BRANCH' : 'Git branch',
    ),
    sourceDirty: gitSource.dirty,
  };
}

export function provenanceArtifactPath(appDirectory: string): string {
  return join(appDirectory, '.open-next', PROVENANCE_FILENAME);
}

export function writeProvenanceArtifact(
  appDirectory: string,
  provenance: WorkerProvenance,
): void {
  const middleware = readFileSync(
    join(appDirectory, '.open-next', 'middleware', 'handler.mjs'),
    'utf8',
  );
  const embeddedRevision = middleware.match(
    /["']key["']\s*:\s*["']X-AgentOS-Git-SHA["']\s*,\s*["']value["']\s*:\s*["']([0-9a-f]{40})["']/i,
  )?.[1]?.toLowerCase();

  if (embeddedRevision !== provenance.gitSha) {
    throw new Error(
      `Generated Worker does not embed Git revision ${provenance.gitSha} in X-AgentOS-Git-SHA.`,
    );
  }

  writeFileSync(
    provenanceArtifactPath(appDirectory),
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8',
  );
}

export function parseProvenanceArtifact(value: string): WorkerProvenance {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error('Worker provenance artifact is not valid JSON.');
  }

  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('schemaVersion' in candidate) ||
    candidate.schemaVersion !== 1 ||
    !('gitSha' in candidate) ||
    typeof candidate.gitSha !== 'string' ||
    !('gitBranch' in candidate) ||
    typeof candidate.gitBranch !== 'string' ||
    !('sourceDirty' in candidate) ||
    typeof candidate.sourceDirty !== 'boolean'
  ) {
    throw new Error('Worker provenance artifact does not match schema version 1.');
  }

  return {
    schemaVersion: 1,
    gitSha: normalizeGitSha(candidate.gitSha, 'Worker provenance gitSha'),
    gitBranch: normalizeGitBranch(
      candidate.gitBranch,
      'Worker provenance gitBranch',
    ),
    sourceDirty: candidate.sourceDirty,
  };
}

export function readProvenanceArtifact(appDirectory: string): WorkerProvenance {
  try {
    return parseProvenanceArtifact(
      readFileSync(provenanceArtifactPath(appDirectory), 'utf8'),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new Error(
        'Worker provenance artifact is missing. Run build:worker before publishing.',
      );
    }
    throw error;
  }
}

export function assertDeployableProvenance(
  provenance: WorkerProvenance,
  gitSource: GitSourceState,
): void {
  if (provenance.sourceDirty) {
    throw new Error(
      'Worker artifact was built with uncommitted tracked changes and cannot map to an exact Git revision.',
    );
  }
  if (gitSource.dirty) {
    throw new Error(
      'Current checkout has uncommitted tracked changes and cannot publish an exact Git revision.',
    );
  }

  const currentSha = normalizeGitSha(gitSource.sha, 'Git HEAD');
  if (currentSha !== provenance.gitSha) {
    throw new Error(
      `Worker artifact was built from ${provenance.gitSha}, but the current checkout is ${currentSha}.`,
    );
  }
}

export function createPreviewAlias(branch: string): string {
  const normalizedBranch = normalizeGitBranch(branch, 'Preview branch');
  const branchSlug =
    normalizedBranch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'branch';
  const alias = `git-${branchSlug}`;
  const maximumAliasLength =
    MAX_DNS_LABEL_LENGTH - WORKER_NAME.length - 1;

  if (alias.length <= maximumAliasLength) return alias;

  const hash = createHash('sha256')
    .update(normalizedBranch)
    .digest('hex')
    .slice(0, 8);
  const prefix = alias
    .slice(0, maximumAliasLength - hash.length - 1)
    .replace(/-+$/g, '');
  return `${prefix}-${hash}`;
}

export function createWorkerCommand(
  mode: PublicationMode,
  provenance: WorkerProvenance,
): string[] {
  const command = mode === 'production' ? ['deploy'] : ['versions', 'upload'];
  const previewAlias = createPreviewAlias(provenance.gitBranch);
  const args = [
    ...command,
    '--tag',
    `git-${provenance.gitSha}`,
    '--message',
    `Git revision ${provenance.gitSha}; branch ${provenance.gitBranch}`,
  ];

  if (mode === 'preview') {
    args.push('--preview-alias', previewAlias);
  }

  return args;
}
