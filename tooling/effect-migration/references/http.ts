import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

export class ProviderStatus extends Schema.Class<ProviderStatus>("ProviderStatus")({
  status: Schema.Literal("ok"),
  requestId: Schema.String
}) {}

export const readProviderStatus = Effect.fn("ProviderStatus.read")(function*(url: URL) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(url).pipe(
    Effect.retry({ times: 2 }),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.withSpan("provider.status.request", {
      attributes: { "agentos.http.host": url.host }
    })
  )
  return yield* HttpClientResponse.schemaBodyJson(ProviderStatus)(response)
})
