import { describe, expect, it } from 'vitest';
import {
  assertDeployableProvenance,
  createPreviewAlias,
  createWorkerCommand,
  parseProvenanceArtifact,
  resolveBuildProvenance,
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
      '--strict',
      '--tag',
      `git-${gitSha}`,
      '--message',
      `git-sha-${gitSha}_branch-git-chore-cloudflare-provenance`,
    ]);
  });

  it('attaches identical metadata and the branch alias to preview versions', () => {
    expect(createWorkerCommand('preview', provenance)).toEqual([
      'upload',
      '--strict',
      '--tag',
      `git-${gitSha}`,
      '--message',
      `git-sha-${gitSha}_branch-git-chore-cloudflare-provenance`,
      '--preview-alias',
      'git-chore-cloudflare-provenance',
    ]);
  });

  it('keeps every passthrough value safe for OpenNext shell forwarding', () => {
    const command = createWorkerCommand('preview', {
      ...provenance,
      gitBranch: 'feat/provenance; echo unsafe',
    });

    expect(command).toContain(
      `git-sha-${gitSha}_branch-git-feat-provenance-echo-unsafe`,
    );
    expect(command.every((value) => /^[a-zA-Z0-9_-]+$/.test(value))).toBe(true);
  });
});
