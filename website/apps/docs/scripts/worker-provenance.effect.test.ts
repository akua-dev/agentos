import * as BunServices from '@effect/platform-bun/BunServices';
import { assert, describe, it } from '@effect/vitest';
import { Effect, FileSystem, Path, Schema } from 'effect';

import {
  assertDeployableProvenance,
  createPreviewAlias,
  createWorkerCommand,
  parseProvenanceArtifact,
  provenanceArtifactPath,
  resolveBuildProvenance,
  WorkerProvenanceFromString,
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
  it.effect('binds a Cloudflare build to its exact checkout revision and branch', () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* resolveBuildProvenance(
          {
            workersCommitSha: gitSha.toUpperCase(),
            workersBranch: 'preview/cloudflare',
          },
          cleanGitSource,
        ),
        {
          schemaVersion: 1,
          gitSha,
          gitBranch: 'preview/cloudflare',
          sourceDirty: false,
        },
      );
    }));

  it.effect('fails closed when Cloudflare identifies a different revision than Git', () =>
    Effect.gen(function*() {
      const failure = yield* resolveBuildProvenance(
        {
          workersCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          workersBranch: gitBranch,
        },
        cleanGitSource,
      ).pipe(Effect.flip);
      assert.include(failure.message, 'does not match the checked-out Git revision');
    }));

  it.effect('rejects malformed or incomplete persisted provenance', () =>
    Effect.gen(function*() {
      const failure = yield* parseProvenanceArtifact(
        '{"schemaVersion":1,"gitSha":"1234567","gitBranch":"main","sourceDirty":false}',
      ).pipe(Effect.flip);
      assert.include(failure.message, 'full 40-character Git SHA');
    }));

  it.effect('refuses to deploy a dirty artifact or from a different checkout', () =>
    Effect.gen(function*() {
      const dirty = yield* assertDeployableProvenance(
        { ...provenance, sourceDirty: true },
        cleanGitSource,
      ).pipe(Effect.flip);
      assert.include(dirty.message, 'uncommitted tracked changes');

      const mismatch = yield* assertDeployableProvenance(provenance, {
        ...cleanGitSource,
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }).pipe(Effect.flip);
      assert.include(mismatch.message, 'was built from');
    }));

  it.effect('persists provenance only for a Worker that embeds the same revision', () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const appDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 'agentos-worker-provenance-',
        });
        const middlewareDirectory = paths.join(
          appDirectory,
          '.open-next',
          'middleware',
        );
        const middlewarePath = paths.join(middlewareDirectory, 'handler.mjs');
        yield* fileSystem.makeDirectory(middlewareDirectory, { recursive: true });

        yield* fileSystem.writeFileString(
          middlewarePath,
          '{"key":"X-AgentOS-Git-SHA","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        );
        const mismatch = yield* writeProvenanceArtifact(
          appDirectory,
          provenance,
        ).pipe(Effect.flip);
        assert.include(mismatch.message, 'does not embed Git revision');

        yield* fileSystem.writeFileString(
          middlewarePath,
          `{"key":"X-AgentOS-Git-SHA","value":"${gitSha}"}`,
        );
        yield* writeProvenanceArtifact(appDirectory, provenance);
        const artifactPath = yield* provenanceArtifactPath(appDirectory);
        const stored = yield* fileSystem.readFileString(artifactPath);
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(WorkerProvenanceFromString)(stored),
          provenance,
        );
      }),
    ).pipe(Effect.provide(BunServices.layer)));
});

describe('Worker version publication', () => {
  it.effect('uses a stable DNS-safe alias for a branch preview', () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* createPreviewAlias('feat/website-posthog'),
        'git-feat-website-posthog',
      );
      const longAlias = yield* createPreviewAlias(
        'feature/this-is-a-deliberately-long-branch-name-for-preview-provenance',
      );
      assert.strictEqual(
        longAlias,
        'git-feature-this-is-a-deliberately-long-b-7ea034b3',
      );
      assert.lengthOf(`${longAlias}-agentos-site`, 63);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect('attaches exact Git metadata to production and preview versions', () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* createWorkerCommand('production', provenance), [
        'deploy',
        '--tag',
        `git-${gitSha}`,
        '--message',
        `Git revision ${gitSha}; branch ${gitBranch}`,
      ]);
      assert.deepStrictEqual(yield* createWorkerCommand('preview', provenance), [
        'versions',
        'upload',
        '--tag',
        `git-${gitSha}`,
        '--message',
        `Git revision ${gitSha}; branch ${gitBranch}`,
        '--preview-alias',
        'git-chore-cloudflare-provenance',
      ]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect('keeps metadata as distinct native Wrangler arguments', () =>
    Effect.gen(function*() {
      const command = yield* createWorkerCommand('preview', {
        ...provenance,
        gitBranch: 'feat/provenance; echo unsafe',
      });
      assert.include(
        command,
        `Git revision ${gitSha}; branch feat/provenance; echo unsafe`,
      );
      assert.include(command, 'git-feat-provenance-echo-unsafe');
    }).pipe(Effect.provide(BunServices.layer)));
});
