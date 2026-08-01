import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Option, Schema } from "effect";

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

export class ReadinessStateError extends Schema.TaggedErrorClass<ReadinessStateError>()(
  "ReadinessStateError",
  {
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

const maximumConfigurationBytes = 1024 * 1024;

function stateError(operation: string, path: string) {
  return ReadinessStateError.make({
    message: `Could not ${operation} semantic readiness state`,
    operation,
    path,
  });
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function optionalEnvironment(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

const readOptionalText = Effect.fn("agentos.readinessState.readOptionalText")(
  function*(path: string, maximumBytes: number) {
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const metadata = await stat(path);
          if (!metadata.isFile() || metadata.size > maximumBytes) {
            throw new Error("file is not a bounded regular file");
          }
          return await readFile(path, "utf8");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
      },
      catch: () => stateError("read", path),
    });
  },
);

const hashOptionalFile = Effect.fn("agentos.readinessState.hashOptionalFile")(
  function*(path: string) {
    const source = yield* readOptionalText(path, maximumConfigurationBytes);
    return source === undefined
      ? null
      : createHash("sha256").update(source).digest("hex");
  },
);

const writePrivateState = Effect.fn("agentos.readinessState.writePrivate")(
  function*(path: string, value: unknown) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.agentos-next`;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        try {
          await writeFile(temporary, `${JSON.stringify(value)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          await chmod(temporary, 0o600);
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: () => stateError("write", path),
    });
  },
);

function decodeState<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
): S["Type"] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(parsed));
}

export const attestPiProviderReadiness = Effect.fn(
  "agentos.readinessState.attestPiProvider",
)(function*(options: {
  readonly environment: Environment;
  readonly piAgentDirectory: string;
  readonly stateDirectory: string;
}) {
  const configuredModeRaw =
    optionalEnvironment(options.environment, "AGENTOS_PI_PROVIDER_MODE") ??
    "direct";
  const configuredMode =
    configuredModeRaw === "ai-gateway" ? "ai_gateway" : configuredModeRaw;
  const mode = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["ai_gateway", "direct"]),
  )(configuredMode).pipe(
    Effect.mapError(() =>
      stateError(
        "validate",
        join(options.stateDirectory, "pi-provider-readiness.json"),
      ),
    ),
  );
  const state = {
    files: {
      markerSha256: yield* hashOptionalFile(
        join(options.stateDirectory, "pi-provider.json"),
      ),
      modelsSha256: yield* hashOptionalFile(
        join(options.piAgentDirectory, "models.json"),
      ),
      settingsSha256: yield* hashOptionalFile(
        join(options.piAgentDirectory, "settings.json"),
      ),
    },
    mode,
    selectedModel:
      optionalEnvironment(options.environment, "AGENTOS_MODEL") ?? null,
    selectedThinking:
      optionalEnvironment(options.environment, "AGENTOS_THINKING") ?? null,
    version: 1,
  } satisfies typeof PiProviderReadinessState.Type;
  yield* writePrivateState(
    join(options.stateDirectory, "pi-provider-readiness.json"),
    state,
  );
  return state;
});

export const writeCoordinationReadiness = Effect.fn(
  "agentos.readinessState.writeCoordination",
)(function*(options: {
  readonly agentName: string;
  readonly herdrSession: string;
  readonly listenerProcessId: number;
  readonly listenerTaskId: string;
  readonly ownerProcessId: number;
  readonly phase: CoordinationReadinessState["phase"];
  readonly stateDirectory: string;
}) {
  const state = yield* Schema.decodeUnknownEffect(CoordinationReadinessState)({
    agentName: options.agentName,
    herdrSession: options.herdrSession,
    listenerProcessId: options.listenerProcessId,
    listenerTaskId: options.listenerTaskId,
    ownerProcessId: options.ownerProcessId,
    phase: options.phase,
    version: 1,
  }).pipe(
    Effect.mapError(() =>
      stateError(
        "validate",
        join(options.stateDirectory, "readiness", "coordination.json"),
      ),
    ),
  );
  yield* writePrivateState(
    join(options.stateDirectory, "readiness", "coordination.json"),
    state,
  );
  return state;
});

export const invalidateCoordinationReadiness = Effect.fn(
  "agentos.readinessState.invalidateCoordination",
)(function*(stateDirectory: string, listenerTaskId: string) {
  const path = join(stateDirectory, "readiness", "coordination.json");
  const source = yield* readOptionalText(path, 64 * 1024);
  if (source === undefined) return;
  const current = decodeState(CoordinationReadinessState, source);
  if (current !== undefined && current.listenerTaskId !== listenerTaskId) return;
  yield* Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: () => stateError("remove", path),
  });
});

export const writeCrewmateReadiness = Effect.fn(
  "agentos.readinessState.writeCrewmate",
)(function*(options: Omit<CrewmateReadinessState, "version"> & {
  readonly stateDirectory: string;
}) {
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
    Effect.mapError(() =>
      stateError(
        "validate",
        join(options.stateDirectory, "readiness", "crewmate.json"),
      ),
    ),
  );
  yield* writePrivateState(
    join(options.stateDirectory, "readiness", "crewmate.json"),
    state,
  );
  return state;
});
