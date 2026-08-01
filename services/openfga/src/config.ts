import { Effect, FileSystem, Redacted, Schema } from "effect";

export class OpenFgaEntrypointError extends Schema.TaggedErrorClass<OpenFgaEntrypointError>()(
  "OpenFgaEntrypointError",
  {
    code: Schema.Literals([
      "missing_environment",
      "invalid_environment",
      "secret_unavailable",
      "deployment_unavailable",
    ]),
    field: Schema.String,
  },
) {}

export function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  const value = environment[name]?.trim();
  return value === undefined || value === ""
    ? Effect.fail(OpenFgaEntrypointError.make({
      code: "missing_environment",
      field: name,
    }))
    : Effect.succeed(value);
}

export function environmentPort(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
) {
  const source = environment[name]?.trim();
  if (source === undefined || source === "") return Effect.succeed(fallback);
  const value = Number(source);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
    ? Effect.succeed(value)
    : Effect.fail(OpenFgaEntrypointError.make({
      code: "invalid_environment",
      field: name,
    }));
}

export const readRedactedFile = Effect.fn("agentos.openfga.readSecret")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(() => OpenFgaEntrypointError.make({
        code: "secret_unavailable",
        field: "secret_file",
      })),
    );
    const value = source.trim();
    if (value === "" || value.length > 16 * 1_024) {
      return yield* OpenFgaEntrypointError.make({
        code: "secret_unavailable",
        field: "secret_file",
      });
    }
    return Redacted.make(value);
  },
);

export const readDeploymentFile = Effect.fn(
  "agentos.openfga.readDeploymentFile",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(() => OpenFgaEntrypointError.make({
      code: "deployment_unavailable",
      field: "deployment_file",
    })),
  );
  const value = source.trim();
  if (value === "" || value.length > 1_024) {
    return yield* OpenFgaEntrypointError.make({
      code: "deployment_unavailable",
      field: "deployment_file",
    });
  }
  return value;
});

export function safeEntrypointFailure(error: unknown) {
  if (
    typeof error === "object" && error !== null &&
    "_tag" in error && typeof error._tag === "string"
  ) {
    return {
      error: error._tag,
      ...("code" in error && typeof error.code === "string"
        ? { code: error.code }
        : {}),
    };
  }
  return { error: "UnknownFailure" };
}
