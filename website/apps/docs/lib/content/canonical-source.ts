import { z } from 'zod';

const repositoryUrl = 'https://github.com/akua-dev/agentos';
const exactGitRevision = /^[0-9a-f]{40}$/;
const safeRepositoryPath = /^[A-Za-z0-9._/-]+$/;

export const canonicalSourceSchema = z.object({
  label: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

export type CanonicalSource = z.infer<typeof canonicalSourceSchema>;

export function canonicalSourceUrl(path: string, revision = 'main'): URL {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    !safeRepositoryPath.test(path)
  ) {
    throw new Error(`Invalid repository-relative canonical source path: ${JSON.stringify(path)}`);
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Invalid repository-relative canonical source path: ${JSON.stringify(path)}`);
  }

  if (revision !== 'main' && !exactGitRevision.test(revision)) {
    throw new Error(`Invalid canonical source Git revision: ${JSON.stringify(revision)}`);
  }

  const leaf = segments.at(-1) ?? '';
  const kind = leaf.includes('.') ? 'blob' : 'tree';
  return new URL(`${repositoryUrl}/${kind}/${revision}/${path}`);
}
