import { Schema } from "effect";

export const AgentOSPackageManifest = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
  exports: Schema.Struct({
    ".": Schema.Struct({
      types: Schema.String,
      import: Schema.String,
    }),
  }),
  keywords: Schema.Array(Schema.String),
  pi: Schema.Struct({
    extensions: Schema.Array(Schema.String),
    skills: Schema.Array(Schema.String),
    prompts: Schema.optional(Schema.Array(Schema.String)),
  }),
});
