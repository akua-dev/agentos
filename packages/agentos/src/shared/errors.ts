import { Effect, Schema, SchemaIssue } from "effect";

export class AgentOSContractError extends Schema.TaggedErrorClass<AgentOSContractError>()(
  "AgentOSContractError",
  {
    boundary: Schema.String,
    code: Schema.Literal("invalid_contract"),
    message: Schema.String,
    path: Schema.String,
  },
) {}

const ValidationCode = Schema.Literals([
  "duplicate_name",
  "invalid_name",
  "invalid_shape",
  "io_failure",
  "limit_exceeded",
  "missing_resource",
  "registration_failed",
  "unsupported_version",
]);

export class AgentOSValidationError extends Schema.TaggedErrorClass<AgentOSValidationError>()(
  "AgentOSValidationError",
  {
    boundary: Schema.String,
    code: ValidationCode,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export const AgentOSFailureEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    context: Schema.Record(Schema.String, Schema.String),
  }),
});

export type AgentOSFailureEnvelope = typeof AgentOSFailureEnvelope.Type;

export function makeValidationError(
  code: AgentOSValidationError["code"],
  boundary: string,
  field: string,
  message: string,
): AgentOSValidationError {
  return AgentOSValidationError.make({ boundary, code, field, message });
}

export function decodeOrValidationError<
  S extends Schema.ConstraintDecoder<unknown>,
>(
  schema: S,
  value: unknown,
  error: AgentOSValidationError,
): Effect.Effect<S["Type"], AgentOSValidationError, S["DecodingServices"]> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => error),
  );
}

const safeBoundaryPattern = /^[a-z0-9_.-]{1,64}$/;
const safePathSegmentPattern = /^[A-Za-z0-9_.-]{1,64}$/;

export function contractError(
  boundary: string,
  issue: SchemaIssue.Issue,
): AgentOSContractError {
  const safeBoundary = safeBoundaryPattern.test(boundary)
    ? boundary
    : "unknown_boundary";
  const path = formatSafePath(firstIssuePath(issue));
  return AgentOSContractError.make({
    boundary: safeBoundary,
    code: "invalid_contract",
    message: `Invalid AgentOS ${safeBoundary} at ${path}`,
    path,
  });
}

function firstIssuePath(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
): ReadonlyArray<PropertyKey> {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
      return firstIssuePath(issue.issue, path);
    case "Pointer":
      return firstIssuePath(issue.issue, [...path, ...issue.path]);
    case "Composite":
    case "AnyOf": {
      const first = issue.issues[0];
      return first === undefined ? path : firstIssuePath(first, path);
    }
    default:
      return path;
  }
}

export function toAgentOSFailureEnvelope(
  error: AgentOSContractError | AgentOSValidationError,
): AgentOSFailureEnvelope {
  return {
    version: 1,
    error: {
      code: error.code,
      message: error.message,
      context: failureContext(error),
    },
  };
}

function failureContext(
  error: AgentOSContractError | AgentOSValidationError,
): Readonly<Record<string, string>> {
  return error._tag === "AgentOSContractError"
    ? { boundary: error.boundary, path: error.path }
    : { boundary: error.boundary, field: error.field };
}

function formatSafePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = "$";
  for (const segment of path.slice(0, 8)) {
    if (typeof segment === "number" && Number.isSafeInteger(segment)) {
      formatted += `[${segment}]`;
      continue;
    }
    if (
      typeof segment === "string" &&
      safePathSegmentPattern.test(segment)
    ) {
      formatted += `.${segment}`;
      continue;
    }
    return "$";
  }
  return formatted;
}
