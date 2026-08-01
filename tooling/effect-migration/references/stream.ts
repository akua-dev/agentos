import { Schema, Stream } from "effect"

export class FleetEvent extends Schema.Class<FleetEvent>("FleetEvent")({
  sequence: Schema.Number,
  kind: Schema.String,
  agentId: Schema.String
}) {}

const decodeFleetEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(FleetEvent))

export const decodeFleetEvents = <E, R>(lines: Stream.Stream<string, E, R>) =>
  lines.pipe(Stream.mapEffect(decodeFleetEvent))
