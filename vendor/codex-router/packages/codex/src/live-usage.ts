import { type UsageSnapshot } from "@akua-dev/codex-router-core"
import { Clock, Context, Effect, Redacted, Schema } from "effect"
import type { SubscriptionCredential } from "./credentials.ts"
import type { CodexControlTransportShape } from "./control-transport.ts"
import { decodeCodexUsage } from "./usage.ts"

export class UsageAuthenticationError extends Schema.TaggedErrorClass<UsageAuthenticationError>()(
  "UsageAuthenticationError",
  {
    generation: Schema.Int.check(Schema.isGreaterThan(0)),
    message: Schema.String
  }
) {}

export class UsageThrottledError extends Schema.TaggedErrorClass<UsageThrottledError>()(
  "UsageThrottledError",
  {
    message: Schema.String,
    retryAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  }
) {}

export class UsageTransportError extends Schema.TaggedErrorClass<UsageTransportError>()(
  "UsageTransportError",
  {
    message: Schema.String
  }
) {}

export class UsagePayloadError extends Schema.TaggedErrorClass<UsagePayloadError>()(
  "UsagePayloadError",
  {
    message: Schema.String
  }
) {}

export type LiveUsageError =
  UsageAuthenticationError | UsageThrottledError | UsageTransportError | UsagePayloadError

export interface UsageProbeShape {
  readonly getUsage: (
    credential: SubscriptionCredential
  ) => Effect.Effect<UsageSnapshot, LiveUsageError>
}

export class UsageProbe extends Context.Service<UsageProbe, UsageProbeShape>()(
  "@akua-dev/codex-router/UsageProbe"
) {}

const authenticationFailure = (generation: number) =>
  new UsageAuthenticationError({
    generation,
    message: "The selected Codex credential was rejected by the usage endpoint"
  })

const payloadFailure = () =>
  new UsagePayloadError({
    message: "The Codex usage response has an unsupported shape"
  })

const transportFailure = () =>
  new UsageTransportError({
    message: "The Codex usage request did not complete"
  })

const parseRetryAt = (value: string | null, now: number): number => {
  if (value === null) {
    return now + 30_000
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + Math.trunc(seconds * 1_000)
  }
  const date = Date.parse(value)
  return Number.isFinite(date) && date > now ? date : now + 30_000
}

export const makeCodexUsageProbe = (options: {
  readonly clock?: () => number
  readonly transport: CodexControlTransportShape
}): UsageProbeShape => {
  const currentTimeMillis =
    options.clock === undefined ? Clock.currentTimeMillis : Effect.sync(options.clock)
  return UsageProbe.of({
    getUsage: Effect.fn("UsageProbe.getUsage")(function* (credential) {
      const observedAt = yield* currentTimeMillis
      const response = yield* options.transport
        .execute(
          new Request("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
              accept: "application/json",
              authorization: credential.authorization,
              "chatgpt-account-id": Redacted.value(credential.providerAccountId)
            },
            method: "GET"
          })
        )
        .pipe(Effect.mapError(transportFailure))
      if (response.status === 401) {
        return yield* authenticationFailure(credential.generation)
      }
      if (response.status === 429) {
        return yield* new UsageThrottledError({
          message: "The Codex usage endpoint throttled the selected account",
          retryAt: parseRetryAt(response.headers["retry-after"] ?? null, observedAt)
        })
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* transportFailure()
      }
      const body = yield* response.json.pipe(Effect.mapError(payloadFailure))
      return yield* decodeCodexUsage(body, observedAt, credential.accountId).pipe(
        Effect.mapError(payloadFailure)
      )
    })
  })
}
