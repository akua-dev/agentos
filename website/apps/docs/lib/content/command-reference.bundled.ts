import compositionVerify from '../../../../../clis/composition-verify/package.json';
import githubAppToken from '../../../../../clis/github-app-token/package.json';
import pgListen from '../../../../../clis/pg-listen/package.json';
import type { CommandReference } from './command-reference';

const packages = [
  ['composition-verify', compositionVerify],
  ['github-app-token', githubAppToken],
  ['pg-listen', pgListen],
] as const;

export const bundledCommandReference: CommandReference[] = packages
  .flatMap(([directory, packageJson]) =>
    Object.keys(packageJson.bin).map((command) => ({
      command,
      description: packageJson.description,
      path: `clis/${directory}` as const,
    })),
  )
  .sort((left, right) => left.command.localeCompare(right.command));
