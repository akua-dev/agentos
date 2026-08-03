import githubAppToken from '../../../../../clis/github-app-token/package.json';
import pgListen from '../../../../../clis/pg-listen/package.json';
import type { CommandReference } from './command-reference';

const packages: ReadonlyArray<{
  readonly directory: string;
  readonly packageJson: {
    readonly description: string;
    readonly bin: Readonly<Record<string, string>>;
  };
}> = [
  { directory: 'github-app-token', packageJson: githubAppToken },
  { directory: 'pg-listen', packageJson: pgListen },
];

export const bundledCommandReference: CommandReference[] = packages
  .flatMap(({ directory, packageJson }) =>
    Object.keys(packageJson.bin).map((command) => ({
      command,
      description: packageJson.description,
      path: commandPath(directory),
    })),
  )
  .sort((left, right) => left.command.localeCompare(right.command));

function commandPath(directory: string): `clis/${string}` {
  return `clis/${directory}`;
}
