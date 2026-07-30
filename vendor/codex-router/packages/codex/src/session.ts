import { SessionKey } from "@akua-dev/codex-router-core"
import { Effect, Option, Schema } from "effect"

const sessionHeaders = [
  "x-codex-router-session",
  "x-ai-gateway-session",
  "session-id",
  "x-codex-session-id",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-state"
]

export class InvalidSessionKeyError extends Schema.TaggedErrorClass<InvalidSessionKeyError>()(
  "InvalidSessionKeyError",
  {
    message: Schema.String
  }
) {}

export const extractSessionKey = Effect.fn("extractSessionKey")(function* (headers: Headers) {
  for (const header of sessionHeaders) {
    const value = headers.get(header)?.trim()
    if (value === undefined || value.length === 0) {
      continue
    }
    if (value.length > 256) {
      return yield* new InvalidSessionKeyError({
        message: "Explicit session identifiers must not exceed 256 characters"
      })
    }
    return Option.some(SessionKey.make(value))
  }
  return Option.none<SessionKey>()
})
