import { z } from 'zod';
import { Effect, Schema } from 'effect';

const repositoryUrl = 'https://github.com/akua-dev/agentos';
const exactGitRevision = /^[0-9a-f]{40}$/;
const safeRepositoryPath = /^[A-Za-z0-9._/-]+$/;

export const canonicalSourceSchema = z.object({
  label: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

export type CanonicalSource = z.infer<typeof canonicalSourceSchema>;

export class CanonicalSourceError extends
  Schema.TaggedErrorClass<CanonicalSourceError>()('CanonicalSourceError', {
    code: Schema.Literals(['invalid_path', 'invalid_revision']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

export const canonicalSourceUrl = Effect.fn(
  'agentos.website.canonicalSourceUrl',
)(function*(path: string, revision = 'main') {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    !safeRepositoryPath.test(path)
  ) {
    return yield* new CanonicalSourceError({
      code: 'invalid_path',
      message: `Invalid repository-relative canonical source path: ${path}`,
    });
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return yield* new CanonicalSourceError({
      code: 'invalid_path',
      message: `Invalid repository-relative canonical source path: ${path}`,
    });
  }

  if (revision !== 'main' && !exactGitRevision.test(revision)) {
    return yield* new CanonicalSourceError({
      code: 'invalid_revision',
      message: `Invalid canonical source Git revision: ${revision}`,
    });
  }

  const leaf = segments.at(-1) ?? '';
  const kind = leaf.includes('.') ? 'blob' : 'tree';
  return yield* Effect.try({
    try: () => new URL(`${repositoryUrl}/${kind}/${revision}/${path}`),
    catch: (cause) =>
      new CanonicalSourceError({
        code: 'invalid_path',
        message: `Could not build canonical source URL: ${path}`,
        cause,
      }),
  });
});
