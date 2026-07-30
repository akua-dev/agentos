import { Option, Schema } from "effect"

export const UpstreamResponseKind = Schema.Literals([
  "success",
  "reauth",
  "quota",
  "forbidden",
  "not_found",
  "client_error",
  "transient"
])
export type UpstreamResponseKind = typeof UpstreamResponseKind.Type

export class UpstreamResponseClassification extends Schema.Class<UpstreamResponseClassification>(
  "UpstreamResponseClassification"
)({
  kind: UpstreamResponseKind,
  retryAt: Schema.Option(Schema.Number)
}) {}

const parseRetryAfter = (value: string | null, now: number): Option.Option<number> => {
  if (value === null) {
    return Option.none()
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Option.some(now + seconds * 1_000)
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Option.some(timestamp) : Option.none()
}

export const classifyUpstreamResponse = (
  status: number,
  headers: Headers,
  now: number
): UpstreamResponseClassification => {
  if (status >= 200 && status < 400) {
    return UpstreamResponseClassification.make({
      kind: "success",
      retryAt: Option.none()
    })
  }
  if (status === 401) {
    return UpstreamResponseClassification.make({
      kind: "reauth",
      retryAt: Option.none()
    })
  }
  if (status === 429) {
    return UpstreamResponseClassification.make({
      kind: "quota",
      retryAt: parseRetryAfter(headers.get("retry-after"), now)
    })
  }
  if (status === 403) {
    return UpstreamResponseClassification.make({
      kind: "forbidden",
      retryAt: Option.none()
    })
  }
  if (status === 404) {
    return UpstreamResponseClassification.make({
      kind: "not_found",
      retryAt: Option.none()
    })
  }
  if (status >= 500) {
    return UpstreamResponseClassification.make({
      kind: "transient",
      retryAt: Option.none()
    })
  }
  return UpstreamResponseClassification.make({
    kind: "client_error",
    retryAt: Option.none()
  })
}
