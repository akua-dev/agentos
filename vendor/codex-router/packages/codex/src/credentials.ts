import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Encoding, Redacted, Schema } from "effect"

export const CredentialGeneration = Schema.Int.check(Schema.isGreaterThan(0))
export type CredentialGeneration = typeof CredentialGeneration.Type

export class InvalidCodexTokenError extends Schema.TaggedErrorClass<InvalidCodexTokenError>()(
  "InvalidCodexTokenError",
  {
    message: Schema.String
  }
) {}

export class SubscriptionCredential extends Schema.Class<SubscriptionCredential>(
  "SubscriptionCredential"
)({
  accessToken: Schema.Redacted(Schema.String),
  accountId: AccountId,
  expiresAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  generation: CredentialGeneration,
  providerAccountId: Schema.Redacted(Schema.String),
  refreshToken: Schema.Redacted(Schema.String)
}) {
  get authorization(): string {
    return `Bearer ${Redacted.value(this.accessToken)}`
  }
}

const JwtPayload = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_account_id: Schema.String.check(Schema.isNonEmpty())
  })
})

const decodeJwtPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(JwtPayload))

const tokenFailure = () =>
  new InvalidCodexTokenError({
    message: "The Codex access token does not contain a usable account identity"
  })

export const extractProviderAccountId = Effect.fn("extractProviderAccountId")(function* (
  accessToken: string
) {
  const parts = accessToken.split(".")
  if (parts.length !== 3 || parts[1] === undefined) {
    return yield* tokenFailure()
  }
  const payloadBytes = yield* Effect.fromResult(Encoding.decodeBase64Url(parts[1])).pipe(
    Effect.mapError(tokenFailure)
  )
  const decoded = yield* decodeJwtPayload(new TextDecoder().decode(payloadBytes)).pipe(
    Effect.mapError(tokenFailure)
  )
  return Redacted.make(decoded["https://api.openai.com/auth"].chatgpt_account_id)
})
