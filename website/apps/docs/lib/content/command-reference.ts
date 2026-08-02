import { Effect, FileSystem, Path, Schema } from 'effect';

export interface CommandReference {
  readonly command: string;
  readonly description: string;
  readonly path: `clis/${string}`;
}

const CliPackageSchema = Schema.Struct({
  description: Schema.String,
  bin: Schema.Record(Schema.String, Schema.Unknown),
});
const CliPackageFromString = Schema.fromJsonString(CliPackageSchema);

export class CommandReferenceError extends
  Schema.TaggedErrorClass<CommandReferenceError>()('CommandReferenceError', {
    code: Schema.Literals(['filesystem', 'invalid_package']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

const referenceError = (
  code: CommandReferenceError['code'],
  message: string,
  cause?: unknown,
) =>
  new CommandReferenceError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export const discoverCommandReference = Effect.fn(
  'agentos.website.discoverCommandReference',
)(function*(clisDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(clisDirectory).pipe(
    Effect.mapError((cause) =>
      referenceError(
        'filesystem',
        `Could not read CLI directory: ${clisDirectory}`,
        cause,
      ),
    ),
  );
  const commands: CommandReference[] = [];

  for (const entry of entries) {
    const directory = paths.join(clisDirectory, entry);
    const isDirectory = yield* fileSystem.stat(directory).pipe(
      Effect.map((info) => info.type === 'Directory'),
      Effect.orElseSucceed(() => false),
    );
    if (!isDirectory) continue;
    const packagePath = paths.join(directory, 'package.json');
    if (!(yield* fileSystem.exists(packagePath))) continue;
    const parsed = yield* fileSystem.readFileString(packagePath).pipe(
      Effect.mapError((cause) =>
        referenceError(
          'filesystem',
          `Could not read CLI package: ${packagePath}`,
          cause,
        ),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(CliPackageFromString)),
      Effect.mapError((cause) =>
        cause instanceof CommandReferenceError
          ? cause
          : referenceError(
            'invalid_package',
            `Could not decode CLI package: ${packagePath}`,
            cause,
          ),
      ),
    );
    const description = parsed.description.trim();
    if (description.length === 0) {
      return yield* referenceError(
        'invalid_package',
        `${packagePath} must define a non-empty description`,
      );
    }
    const binaries = Object.keys(parsed.bin).sort();
    if (binaries.length === 0) {
      return yield* referenceError(
        'invalid_package',
        `${packagePath} must define command binaries`,
      );
    }
    for (const command of binaries) {
      commands.push({
        command,
        description,
        path: commandPath(paths.basename(directory)),
      });
    }
  }

  return commands.sort((left, right) =>
    left.command.localeCompare(right.command)
  );
});

function commandPath(directory: string): `clis/${string}` {
  return `clis/${directory}`;
}
