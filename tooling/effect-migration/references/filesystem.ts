import { Effect, FileSystem, Schema } from "effect"

export class RuntimeMarker extends Schema.Class<RuntimeMarker>("RuntimeMarker")({
  agentId: Schema.String,
  revision: Schema.String,
  ready: Schema.Boolean
}) {}

export const readRuntimeMarker = Effect.fn("RuntimeMarker.read")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const contents = yield* fs.readFileString(file)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeMarker))(contents)
})

export const writeRuntimeMarker = Effect.fn("RuntimeMarker.write")(function*(
  file: string,
  marker: RuntimeMarker
) {
  const fs = yield* FileSystem.FileSystem
  const contents = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(RuntimeMarker))(marker)
  yield* fs.writeFileString(file, `${contents}\n`)
})
