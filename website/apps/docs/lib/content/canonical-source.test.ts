import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'tinyglobby';
import { canonicalSourceUrl } from './canonical-source';

describe('canonicalSourceUrl', () => {
  it.each([
    ['README.md', 'https://github.com/akua-dev/agentos/blob/main/README.md'],
    [
      'agents/firstmate/.agents/skills/agentos-bootstrap/SKILL.md',
      'https://github.com/akua-dev/agentos/blob/main/agents/firstmate/.agents/skills/agentos-bootstrap/SKILL.md',
    ],
    [
      'database/migrations',
      'https://github.com/akua-dev/agentos/tree/main/database/migrations',
    ],
  ])('maps %s to its public repository URL', (path, expected) => {
    expect(canonicalSourceUrl(path).toString()).toBe(expected);
  });

  it.each(['', '/etc/passwd', 'https://example.com', '../README.md', 'a/../b', 'bad\npath'])(
    'rejects unsafe path %j',
    (path) => {
      expect(() => canonicalSourceUrl(path)).toThrow();
    },
  );

  it('accepts an immutable Git revision', () => {
    const revision = '0123456789abcdef0123456789abcdef01234567';
    expect(canonicalSourceUrl('README.md', revision).toString()).toBe(
      `https://github.com/akua-dev/agentos/blob/${revision}/README.md`,
    );
  });

  it.each(['abc123', 'g'.repeat(40)])('rejects invalid revision %j', (revision) => {
    expect(() => canonicalSourceUrl('README.md', revision)).toThrow();
  });

  it('keeps every published canonical source anchored to the repository', async () => {
    const siteRoot = fileURLToPath(new URL('../../', import.meta.url));
    const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const files = await glob('content/{docs,learn}/**/*.mdx', { cwd: siteRoot });
    const missing: string[] = [];
    let sourceCount = 0;

    for (const file of files) {
      const content = await readFile(resolve(siteRoot, file), 'utf8');
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

      for (const match of frontmatter.matchAll(/^\s+path:\s+(.+)$/gm)) {
        const path = match[1]?.trim();
        if (!path) continue;
        sourceCount += 1;

        try {
          await access(resolve(repositoryRoot, path));
        } catch {
          missing.push(`${file}: ${path}`);
        }
      }
    }

    expect(sourceCount).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
