import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { discoverCommandReference } from './command-reference';
import { bundledCommandReference } from './command-reference.bundled';

describe('discoverCommandReference', () => {
  it('matches every implemented AgentOS CLI package', async () => {
    const commands = await discoverCommandReference(
      fileURLToPath(new URL('../../../../../clis/', import.meta.url)),
    );
    const expected = [
      {
        command: 'github-app-token',
        description: 'Mint and safely materialize a scoped GitHub App installation token',
        path: 'clis/github-app-token',
      },
      {
        command: 'pg-listen',
        description: 'Wait for one PostgreSQL notification and exit',
        path: 'clis/pg-listen',
      },
    ];

    expect(commands).toEqual(expected);
    expect(bundledCommandReference).toEqual(expected);
  });
});
