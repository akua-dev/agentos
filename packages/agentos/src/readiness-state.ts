import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import { AgentOSIdentifier } from "./shared/services.ts";

const FileHashes = Schema.Struct({
  markerSha256: Schema.NullOr(Schema.String),
  modelsSha256: Schema.NullOr(Schema.String),
  settingsSha256: Schema.NullOr(Schema.String),
});
export const PiProviderReadinessState = Schema.Struct({
  files: FileHashes,
  mode: Schema.Literals(["ai_gateway", "direct"]),
  selectedModel: Schema.NullOr(Schema.String),
  selectedThinking: Schema.NullOr(Schema.String),
  version: Schema.Literal(1),
});
export const CoordinationReadinessState = Schema.Struct({
  agentName: Schema.String,
  herdrSession: Schema.String,
  listenerProcessId: Schema.Number,
  listenerTaskId: Schema.String,
  ownerProcessId: Schema.Number,
  phase: Schema.Literals(["caught_up", "listening"]),
  version: Schema.Literal(1),
});
export const CrewmateReadinessState = Schema.Struct({
  agentId: Schema.String,
  assignmentId: Schema.String,
  briefSha256: Schema.String,
  harness: Schema.String,
  herdrSession: Schema.String,
  processId: Schema.Number,
  taskId: Schema.String,
  version: Schema.Literal(1),
});

type Environment = Readonly<Record<string, string | undefined>>;
type CoordinationReadinessState = typeof CoordinationReadinessState.Type;
type CrewmateReadinessState = typeof CrewmateReadinessState.Type;

interface PiProviderReadinessOptions {
  readonly environment: Environment;
  readonly piAgentDirectory: string;
  readonly stateDirectory: string;
}

interface CoordinationReadinessOptions {
  readonly agentName: string;
  readonly herdrSession: string;
  readonly listenerProcessId: number;
  readonly listenerTaskId: string;
  readonly ownerProcessId: number;
  readonly phase: CoordinationReadinessState["phase"];
  readonly stateDirectory: string;
}

type CrewmateReadinessOptions = Omit<CrewmateReadinessState, "version"> & {
  readonly stateDirectory: string;
};

export class ReadinessStateError extends Schema.TaggedErrorClass<ReadinessStateError>()(
  "ReadinessStateError",
  {
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

const maximumConfigurationBytes = 1024 * 1024;
const maximumReadinessBytes = 64 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

const ReadinessStateLive = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
  AgentOSIdentifier.layer,
);

function stateError(operation: string, path: string) {
  return ReadinessStateError.make({
    message: `Could not ${operation} semantic readiness state`,
    operation,
    path,
  });
}

function optionalEnvironment(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

const readOptionalText = Effect.fn("agentos.readinessState.readOptionalText")(
  function*(path: string, maximumBytes: number) {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(path).pipe(
      Effect.mapError(() => stateError("read", path)),
    );
    if (!exists) return undefined;
    const metadata = yield* fileSystem.stat(path).pipe(
      Effect.mapError(() => stateError("read", path)),
    );
    if (
      metadata.type !== "File" ||
      metadata.size > FileSystem.Size(maximumBytes)
    ) {
      return yield* stateError("read", path);
    }
    return yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(() => stateError("read", path)),
    );
  },
);

const hashOptionalFile = Effect.fn("agentos.readinessState.hashOptionalFile")(
  function*(path: string) {
    const source = yield* readOptionalText(path, maximumConfigurationBytes);
    if (source === undefined) return null;
    const crypto = yield* Crypto.Crypto;
    return Encoding.encodeHex(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(source)).pipe(
        Effect.mapError(() => stateError("hash", path)),
      ),
    );
  },
);

function writePrivateState<S extends Schema.Constraint>(
  path: string,
  schema: S,
  value: S["Type"],
) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const identifiers = yield* AgentOSIdentifier;
    const temporaryIdentifier = yield* identifiers.next.pipe(
      Effect.mapError(() => stateError("write", path)),
    );
    const temporary = `${path}.${temporaryIdentifier}.agentos-next`;
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(
      value,
    ).pipe(Effect.mapError(() => stateError("write", path)));

    yield* fileSystem
      .makeDirectory(paths.dirname(path), {
        mode: privateDirectoryMode,
        recursive: true,
      })
      .pipe(Effect.mapError(() => stateError("write", path)));

    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(temporary, `${source}\n`, {
        flag: "wx",
        mode: privateFileMode,
      });
      yield* fileSystem.chmod(temporary, privateFileMode);
      yield* fileSystem.rename(temporary, path);
    }).pipe(
      Effect.mapError(() => stateError("write", path)),
      Effect.ensuring(
        fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
      ),
    );
  });
}

function decodeState<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source).pipe(
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
}

export const attestPiProviderReadinessEffect = Effect.fn(
  "agentos.readinessState.attestPiProvider.effect",
)(function*(options: PiProviderReadinessOptions) {
  const paths = yield* Path.Path;
  const readinessPath = paths.join(
    options.stateDirectory,
    "pi-provider-readiness.json",
  );
  const configuredModeRaw =
    optionalEnvironment(options.environment, "AGENTOS_PI_PROVIDER_MODE") ??
    "direct";
  const configuredMode =
    configuredModeRaw === "ai-gateway" ? "ai_gateway" : configuredModeRaw;
  const mode = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["ai_gateway", "direct"]),
  )(configuredMode).pipe(
    Effect.mapError(() => stateError("validate", readinessPath)),
  );
  const state = {
    files: {
      markerSha256: yield* hashOptionalFile(
        paths.join(options.stateDirectory, "pi-provider.json"),
      ),
      modelsSha256: yield* hashOptionalFile(
        paths.join(options.piAgentDirectory, "models.json"),
      ),
      settingsSha256: yield* hashOptionalFile(
        paths.join(options.piAgentDirectory, "settings.json"),
      ),
    },
    mode,
    selectedModel:
      optionalEnvironment(options.environment, "AGENTOS_MODEL") ?? null,
    selectedThinking:
      optionalEnvironment(options.environment, "AGENTOS_THINKING") ?? null,
    version: 1,
  } satisfies typeof PiProviderReadinessState.Type;
  yield* writePrivateState(readinessPath, PiProviderReadinessState, state);
  return state;
});

export const writeCoordinationReadinessEffect = Effect.fn(
  "agentos.readinessState.writeCoordination.effect",
)(function*(options: CoordinationReadinessOptions) {
  const paths = yield* Path.Path;
  const readinessPath = paths.join(
    options.stateDirectory,
    "readiness",
    "coordination.json",
  );
  const state = yield* Schema.decodeUnknownEffect(CoordinationReadinessState)({
    agentName: options.agentName,
    herdrSession: options.herdrSession,
    listenerProcessId: options.listenerProcessId,
    listenerTaskId: options.listenerTaskId,
    ownerProcessId: options.ownerProcessId,
    phase: options.phase,
    version: 1,
  }).pipe(
    Effect.mapError(() => stateError("validate", readinessPath)),
  );
  yield* writePrivateState(readinessPath, CoordinationReadinessState, state);
  return state;
});

export const invalidateCoordinationReadinessEffect = Effect.fn(
  "agentos.readinessState.invalidateCoordination.effect",
)(function*(stateDirectory: string, listenerTaskId: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const readinessPath = paths.join(
    stateDirectory,
    "readiness",
    "coordination.json",
  );
  const source = yield* readOptionalText(readinessPath, maximumReadinessBytes);
  if (source === undefined) return;
  const current = yield* decodeState(CoordinationReadinessState, source);
  if (current !== undefined && current.listenerTaskId !== listenerTaskId) return;
  yield* fileSystem.remove(readinessPath, { force: true }).pipe(
    Effect.mapError(() => stateError("remove", readinessPath)),
  );
});

export const writeCrewmateReadinessEffect = Effect.fn(
  "agentos.readinessState.writeCrewmate.effect",
)(function*(options: CrewmateReadinessOptions) {
  const paths = yield* Path.Path;
  const readinessPath = paths.join(
    options.stateDirectory,
    "readiness",
    "crewmate.json",
  );
  const state = yield* Schema.decodeUnknownEffect(CrewmateReadinessState)({
    agentId: options.agentId,
    assignmentId: options.assignmentId,
    briefSha256: options.briefSha256,
    harness: options.harness,
    herdrSession: options.herdrSession,
    processId: options.processId,
    taskId: options.taskId,
    version: 1,
  }).pipe(
    Effect.mapError(() => stateError("validate", readinessPath)),
  );
  yield* writePrivateState(readinessPath, CrewmateReadinessState, state);
  return state;
});

export function attestPiProviderReadiness(options: PiProviderReadinessOptions) {
  return attestPiProviderReadinessEffect(options).pipe(
    Effect.provide(ReadinessStateLive),
  );
}

export function writeCoordinationReadiness(
  options: CoordinationReadinessOptions,
) {
  return writeCoordinationReadinessEffect(options).pipe(
    Effect.provide(ReadinessStateLive),
  );
}

export function invalidateCoordinationReadiness(
  stateDirectory: string,
  listenerTaskId: string,
) {
  return invalidateCoordinationReadinessEffect(
    stateDirectory,
    listenerTaskId,
  ).pipe(Effect.provide(ReadinessStateLive));
}

export function writeCrewmateReadiness(options: CrewmateReadinessOptions) {
  return writeCrewmateReadinessEffect(options).pipe(
    Effect.provide(ReadinessStateLive),
  );
}
