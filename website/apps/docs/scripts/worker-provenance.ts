import {
  Config,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Option,
  Path,
  Runtime,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/unstable/process';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_DNS_LABEL_LENGTH = 63;
const WORKER_NAME = 'agentos-site';
const PROVENANCE_FILENAME = 'agentos-provenance.json';

export interface GitSourceState {
  readonly sha: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export interface WorkerProvenance {
  readonly schemaVersion: 1;
  readonly gitSha: string;
  readonly gitBranch: string;
  readonly sourceDirty: boolean;
}

export interface BuildEnvironment {
  readonly workersCommitSha?: string;
  readonly workersBranch?: string;
  readonly githubHeadRef?: string;
  readonly githubRefName?: string;
}

export type PublicationMode = 'preview' | 'production';

export const WorkerProvenanceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  gitSha: Schema.String,
  gitBranch: Schema.String,
  sourceDirty: Schema.Boolean,
});
export const WorkerProvenanceFromString = Schema.fromJsonString(
  WorkerProvenanceSchema,
);

export class WorkerProvenanceError extends
  Schema.TaggedErrorClass<WorkerProvenanceError>()('WorkerProvenanceError', {
    code: Schema.Literals([
      'artifact',
      'configuration',
      'filesystem',
      'git',
      'mismatch',
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optional(Schema.Number),
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

const BuildEnvironmentConfig = Config.all({
  workersCommitSha: Config.option(Config.string('WORKERS_CI_COMMIT_SHA')),
  workersBranch: Config.option(Config.string('WORKERS_CI_BRANCH')),
  githubHeadRef: Config.option(Config.string('GITHUB_HEAD_REF')),
  githubRefName: Config.option(Config.string('GITHUB_REF_NAME')),
});

export const loadBuildEnvironment = Effect.gen(function*() {
  const config = yield* BuildEnvironmentConfig;
  return {
    workersCommitSha: Option.getOrUndefined(config.workersCommitSha),
    workersBranch: Option.getOrUndefined(config.workersBranch),
    githubHeadRef: Option.getOrUndefined(config.githubHeadRef),
    githubRefName: Option.getOrUndefined(config.githubRefName),
  } satisfies BuildEnvironment;
}).pipe(Effect.withSpan('agentos.website.loadBuildEnvironment'));

const normalizeGitSha = Effect.fn('agentos.website.normalizeGitSha')(
  function*(value: string, source: string) {
    const sha = value.trim().toLowerCase();
    if (!FULL_GIT_SHA.test(sha)) {
      return yield* new WorkerProvenanceError({
        code: 'configuration',
        message: `${source} must be a full 40-character Git SHA.`,
      });
    }
    return sha;
  },
);

const normalizeGitBranch = Effect.fn('agentos.website.normalizeGitBranch')(
  function*(value: string, source: string) {
    const branch = value.trim();
    if (branch.length === 0 || /[\0\r\n]/.test(branch)) {
      return yield* new WorkerProvenanceError({
        code: 'configuration',
        message: `${source} must be a non-empty Git branch without control characters.`,
      });
    }
    return branch;
  },
);

const runGit = Effect.fn('agentos.website.runGit')(
  function*(cwd: string, args: ReadonlyArray<string>, allowEmpty = false) {
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const child = yield* ChildProcess.make('git', args, {
          cwd,
          stderr: 'pipe',
          stdout: 'pipe',
        });
        const [exitCode, stderr, stdout] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 'unbounded' },
        );
        return { exitCode, stderr, stdout };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerProvenanceError({
            code: 'git',
            message: `Could not execute git ${args.join(' ')}`,
            cause,
          }),
      ),
    );

    if (result.exitCode !== 0) {
      return yield* new WorkerProvenanceError({
        code: 'git',
        message: `git ${args.join(' ')} failed with exit code ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}.`,
        exitCode: result.exitCode,
      });
    }
    const output = result.stdout.trim();
    if (!allowEmpty && output.length === 0) {
      return yield* new WorkerProvenanceError({
        code: 'git',
        message: `git ${args.join(' ')} returned no value.`,
      });
    }
    return output;
  },
);

export const readGitSourceState = Effect.fn(
  'agentos.website.readGitSourceState',
)(function*(cwd: string, environment: BuildEnvironment) {
  const [rawSha, detectedBranch, status] = yield* Effect.all(
    [
      runGit(cwd, ['rev-parse', 'HEAD']),
      runGit(cwd, ['branch', '--show-current'], true),
      runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no'], true),
    ],
    { concurrency: 'unbounded' },
  );
  const sha = yield* normalizeGitSha(rawSha, 'Git HEAD');
  const branch = yield* normalizeGitBranch(
    detectedBranch ||
      environment.workersBranch ||
      environment.githubHeadRef ||
      environment.githubRefName ||
      'detached',
    'Git branch',
  );
  return { sha, branch, dirty: status.length > 0 } satisfies GitSourceState;
});

export const resolveBuildProvenance = Effect.fn(
  'agentos.website.resolveBuildProvenance',
)(function*(environment: BuildEnvironment, gitSource: GitSourceState) {
  const gitSha = yield* normalizeGitSha(
    environment.workersCommitSha ?? gitSource.sha,
    environment.workersCommitSha === undefined
      ? 'Git revision'
      : 'WORKERS_CI_COMMIT_SHA',
  );
  const checkoutSha = yield* normalizeGitSha(gitSource.sha, 'Git HEAD');
  if (gitSha !== checkoutSha) {
    return yield* new WorkerProvenanceError({
      code: 'mismatch',
      message: `Cloudflare build revision ${gitSha} does not match the checked-out Git revision ${checkoutSha}.`,
    });
  }

  return {
    schemaVersion: 1,
    gitSha,
    gitBranch: yield* normalizeGitBranch(
      environment.workersBranch ?? gitSource.branch,
      environment.workersBranch === undefined
        ? 'Git branch'
        : 'WORKERS_CI_BRANCH',
    ),
    sourceDirty: gitSource.dirty,
  } satisfies WorkerProvenance;
});

export const provenanceArtifactPath = Effect.fn(
  'agentos.website.provenanceArtifactPath',
)(function*(appDirectory: string) {
  const paths = yield* Path.Path;
  return paths.join(appDirectory, '.open-next', PROVENANCE_FILENAME);
});

export const writeProvenanceArtifact = Effect.fn(
  'agentos.website.writeProvenanceArtifact',
)(function*(appDirectory: string, provenance: WorkerProvenance) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const middlewarePath = paths.join(
    appDirectory,
    '.open-next',
    'middleware',
    'handler.mjs',
  );
  const middleware = yield* fileSystem.readFileString(middlewarePath).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'filesystem',
          message: 'Could not read the generated Worker middleware',
          cause,
        }),
    ),
  );
  const embeddedRevision = middleware.match(
    /["']key["']\s*:\s*["']X-AgentOS-Git-SHA["']\s*,\s*["']value["']\s*:\s*["']([0-9a-f]{40})["']/i,
  )?.[1]?.toLowerCase();
  if (embeddedRevision !== provenance.gitSha) {
    return yield* new WorkerProvenanceError({
      code: 'mismatch',
      message: `Generated Worker does not embed Git revision ${provenance.gitSha} in X-AgentOS-Git-SHA.`,
    });
  }

  const encoded = yield* Schema.encodeEffect(WorkerProvenanceFromString)(
    provenance,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'artifact',
          message: 'Could not encode Worker provenance artifact',
          cause,
        }),
    ),
  );
  const artifactPath = yield* provenanceArtifactPath(appDirectory);
  yield* fileSystem.writeFileString(artifactPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'filesystem',
          message: 'Could not write Worker provenance artifact',
          cause,
        }),
    ),
  );
});

export const parseProvenanceArtifact = Effect.fn(
  'agentos.website.parseProvenanceArtifact',
)(function*(value: string) {
  const candidate = yield* Schema.decodeUnknownEffect(
    WorkerProvenanceFromString,
  )(value).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'artifact',
          message: 'Worker provenance artifact does not match schema version 1.',
          cause,
        }),
    ),
  );
  return {
    schemaVersion: 1,
    gitSha: yield* normalizeGitSha(
      candidate.gitSha,
      'Worker provenance gitSha',
    ),
    gitBranch: yield* normalizeGitBranch(
      candidate.gitBranch,
      'Worker provenance gitBranch',
    ),
    sourceDirty: candidate.sourceDirty,
  } satisfies WorkerProvenance;
});

export const readProvenanceArtifact = Effect.fn(
  'agentos.website.readProvenanceArtifact',
)(function*(appDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const artifactPath = yield* provenanceArtifactPath(appDirectory);
  const source = yield* fileSystem.readFileString(artifactPath).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'filesystem',
          message:
            'Worker provenance artifact is missing. Run build:worker before publishing.',
          cause,
        }),
    ),
  );
  return yield* parseProvenanceArtifact(source);
});

export const assertDeployableProvenance = Effect.fn(
  'agentos.website.assertDeployableProvenance',
)(function*(provenance: WorkerProvenance, gitSource: GitSourceState) {
  if (provenance.sourceDirty) {
    return yield* new WorkerProvenanceError({
      code: 'mismatch',
      message:
        'Worker artifact was built with uncommitted tracked changes and cannot map to an exact Git revision.',
    });
  }
  if (gitSource.dirty) {
    return yield* new WorkerProvenanceError({
      code: 'mismatch',
      message:
        'Current checkout has uncommitted tracked changes and cannot publish an exact Git revision.',
    });
  }

  const currentSha = yield* normalizeGitSha(gitSource.sha, 'Git HEAD');
  if (currentSha !== provenance.gitSha) {
    return yield* new WorkerProvenanceError({
      code: 'mismatch',
      message: `Worker artifact was built from ${provenance.gitSha}, but the current checkout is ${currentSha}.`,
    });
  }
});

export const createPreviewAlias = Effect.fn(
  'agentos.website.createPreviewAlias',
)(function*(branch: string) {
  const normalizedBranch = yield* normalizeGitBranch(branch, 'Preview branch');
  const branchSlug =
    normalizedBranch
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'branch';
  const alias = `git-${branchSlug}`;
  const maximumAliasLength = MAX_DNS_LABEL_LENGTH - WORKER_NAME.length - 1;
  if (alias.length <= maximumAliasLength) return alias;

  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    'SHA-256',
    new TextEncoder().encode(normalizedBranch),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerProvenanceError({
          code: 'configuration',
          message: 'Could not hash the preview branch',
          cause,
        }),
    ),
  );
  const hash = Encoding.encodeHex(digest).slice(0, 8);
  const prefix = alias
    .slice(0, maximumAliasLength - hash.length - 1)
    .replace(/-+$/g, '');
  return `${prefix}-${hash}`;
});

export const createWorkerCommand = Effect.fn(
  'agentos.website.createWorkerCommand',
)(function*(mode: PublicationMode, provenance: WorkerProvenance) {
  const command = mode === 'production' ? ['deploy'] : ['versions', 'upload'];
  const args = [
    ...command,
    '--tag',
    `git-${provenance.gitSha}`,
    '--message',
    `Git revision ${provenance.gitSha}; branch ${provenance.gitBranch}`,
  ];
  if (mode === 'preview') {
    args.push('--preview-alias', yield* createPreviewAlias(provenance.gitBranch));
  }
  return args;
});
