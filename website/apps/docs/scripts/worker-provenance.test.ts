import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDeployableProvenance,
  createPreviewAlias,
  createWorkerCommand,
  parseProvenanceArtifact,
  resolveBuildProvenance,
  writeProvenanceArtifact,
  type GitSourceState,
  type WorkerProvenance,
} from './worker-provenance';

const gitSha = '1234567890abcdef1234567890abcdef12345678';
const gitBranch = 'chore/cloudflare-provenance';

const cleanGitSource: GitSourceState = {
  sha: gitSha,
  branch: gitBranch,
  dirty: false,
};

const provenance: WorkerProvenance = {
  schemaVersion: 1,
  gitSha,
  gitBranch,
  sourceDirty: false,
};

describe('Worker build provenance', () => {
  it('binds a Cloudflare build to its exact checkout revision and branch', () => {
    expect(
      resolveBuildProvenance(
        {
          WORKERS_CI_COMMIT_SHA: gitSha.toUpperCase(),
          WORKERS_CI_BRANCH: 'preview/cloudflare',
        },
        cleanGitSource,
      ),
    ).toEqual({
      schemaVersion: 1,
      gitSha,
      gitBranch: 'preview/cloudflare',
      sourceDirty: false,
    });
  });

  it('fails closed when Cloudflare identifies a different revision than Git', () => {
    expect(() =>
      resolveBuildProvenance(
        {
          WORKERS_CI_COMMIT_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          WORKERS_CI_BRANCH: gitBranch,
        },
        cleanGitSource,
      ),
    ).toThrow('does not match the checked-out Git revision');
  });

  it('rejects malformed or incomplete persisted provenance', () => {
    expect(() =>
      parseProvenanceArtifact(
        JSON.stringify({
          schemaVersion: 1,
          gitSha: '1234567',
          gitBranch,
          sourceDirty: false,
        }),
      ),
    ).toThrow('full 40-character Git SHA');
  });

  it('refuses to deploy a dirty artifact or from a different checkout', () => {
    expect(() =>
      assertDeployableProvenance(
        { ...provenance, sourceDirty: true },
        cleanGitSource,
      ),
    ).toThrow('uncommitted tracked changes');

    expect(() =>
      assertDeployableProvenance(provenance, {
        ...cleanGitSource,
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow('was built from');
  });

  it('persists provenance only for a Worker that embeds the same revision', () => {
    const appDirectory = mkdtempSync(
      join(tmpdir(), 'agentos-worker-provenance-'),
    );
    const middlewareDirectory = join(
      appDirectory,
      '.open-next',
      'middleware',
    );
    const middlewarePath = join(middlewareDirectory, 'handler.mjs');
    mkdirSync(middlewareDirectory, { recursive: true });

    try {
      writeFileSync(
        middlewarePath,
        '{"key":"X-AgentOS-Git-SHA","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      );
      expect(() =>
        writeProvenanceArtifact(appDirectory, provenance),
      ).toThrow('does not embed Git revision');

      writeFileSync(
        middlewarePath,
        `{"key":"X-AgentOS-Git-SHA","value":"${gitSha}"}`,
      );
      writeProvenanceArtifact(appDirectory, provenance);
      expect(
        JSON.parse(
          readFileSync(
            join(appDirectory, '.open-next', 'agentos-provenance.json'),
            'utf8',
          ),
        ),
      ).toEqual(provenance);
    } finally {
      rmSync(appDirectory, { recursive: true, force: true });
    }
  });
});

describe('Worker version publication', () => {
  it('uses a stable DNS-safe alias for a branch preview', () => {
    expect(createPreviewAlias('feat/website-posthog')).toBe(
      'git-feat-website-posthog',
    );

    const longAlias = createPreviewAlias(
      'feature/this-is-a-deliberately-long-branch-name-for-preview-provenance',
    );
    expect(longAlias).toBe(
      'git-feature-this-is-a-deliberately-long-b-7ea034b3',
    );
    expect(`${longAlias}-agentos-site`).toHaveLength(63);
  });

  it('attaches the exact Git revision to production version metadata', () => {
    expect(createWorkerCommand('production', provenance)).toEqual([
      'deploy',
      '--tag',
      `git-${gitSha}`,
      '--message',
      `Git revision ${gitSha}; branch ${gitBranch}`,
    ]);
  });

  it('attaches identical metadata and the branch alias to preview versions', () => {
    expect(createWorkerCommand('preview', provenance)).toEqual([
      'versions',
      'upload',
      '--tag',
      `git-${gitSha}`,
      '--message',
      `Git revision ${gitSha}; branch ${gitBranch}`,
      '--preview-alias',
      'git-chore-cloudflare-provenance',
    ]);
  });

  it('keeps metadata as distinct native Wrangler arguments', () => {
    const command = createWorkerCommand('preview', {
      ...provenance,
      gitBranch: 'feat/provenance; echo unsafe',
    });

    expect(command).toContain(
      `Git revision ${gitSha}; branch feat/provenance; echo unsafe`,
    );
    expect(command).toContain('git-feat-provenance-echo-unsafe');
  });
});
