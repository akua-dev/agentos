import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface CommandReference {
  command: string;
  description: string;
  path: `clis/${string}`;
}

interface CliPackage {
  description?: unknown;
  bin?: unknown;
}

export async function discoverCommandReference(clisDirectory: string): Promise<CommandReference[]> {
  const entries = await readdir(clisDirectory, { withFileTypes: true });
  const commands: CommandReference[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(clisDirectory, entry.name, 'package.json');

    let parsed: CliPackage;
    try {
      parsed = JSON.parse(await readFile(packagePath, 'utf8')) as CliPackage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    if (typeof parsed.description !== 'string' || parsed.description.trim().length === 0) {
      throw new Error(`${packagePath} must define a non-empty description`);
    }
    if (!parsed.bin || typeof parsed.bin !== 'object' || Array.isArray(parsed.bin)) {
      throw new Error(`${packagePath} must define command binaries`);
    }

    for (const command of Object.keys(parsed.bin).sort()) {
      commands.push({
        command,
        description: parsed.description,
        path: `clis/${basename(entry.name)}`,
      });
    }
  }

  return commands.sort((left, right) => left.command.localeCompare(right.command));
}
