import { Effect, Schema } from "effect";

import { contractError, type AgentOSContractError } from "./errors.ts";

export const QualifiedNameSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9@._:/-]+$/),
  ),
);

export const PiSkillNameSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ),
);

export const NonBlankStringSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      expected: "a non-blank string",
    }),
  ),
);

export const AgentOSNameClaimsV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  tools: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(QualifiedNameSchema))),
  commands: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(QualifiedNameSchema))),
  skills: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(PiSkillNameSchema))),
  messages: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(QualifiedNameSchema))),
  entries: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(QualifiedNameSchema))),
});

export const AgentOSInstructionSourceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  id: QualifiedNameSchema,
  content: NonBlankStringSchema,
});

export const AgentOSResourceInputV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  baseDirectory: Schema.NonEmptyString,
  skillPaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
  promptPaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
  themePaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
});

export const AgentOSResourcesV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  skillPaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
  promptPaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
  themePaths: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.NonEmptyString))),
});

export const AgentOSStartupContributionV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  id: QualifiedNameSchema,
  skill: PiSkillNameSchema,
  instruction: Schema.NonEmptyString,
});

export type AgentOSNameClaimsV1 = typeof AgentOSNameClaimsV1Schema.Type;
export type AgentOSInstructionSourceV1 =
  typeof AgentOSInstructionSourceV1Schema.Type;
export type AgentOSResourceInputV1 = typeof AgentOSResourceInputV1Schema.Type;
export type AgentOSResourcesV1 = typeof AgentOSResourcesV1Schema.Type;
export type AgentOSStartupContributionV1 =
  typeof AgentOSStartupContributionV1Schema.Type;

export function decodeAgentOSContract<
  S extends Schema.ConstraintDecoder<unknown>,
>(schema: S, boundary: string) {
  return (
    input: unknown,
  ): Effect.Effect<S["Type"], AgentOSContractError, S["DecodingServices"]> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => contractError(boundary, error.issue)),
    );
}
