import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export class CodexControlTransportError extends Schema.TaggedErrorClass<CodexControlTransportError>()(
  "CodexControlTransportError",
  {
    message: Schema.String
  }
) {}

export interface CodexControlTransportShape {
  readonly execute: (
    request: Request
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, CodexControlTransportError>
}

export class CodexControlTransport extends Context.Service<
  CodexControlTransport,
  CodexControlTransportShape
>()("@akua-dev/codex-router/CodexControlTransport") {}

const transportFailure = () =>
  new CodexControlTransportError({
    message: "The Codex control-plane request did not complete"
  })

export const makeHttpClientCodexControlTransport = (
  client: HttpClient.HttpClient
): CodexControlTransportShape =>
  CodexControlTransport.of({
    execute: Effect.fn("CodexControlTransport.execute")((request) =>
      client.execute(HttpClientRequest.fromWeb(request)).pipe(Effect.mapError(transportFailure))
    )
  })

export const codexControlTransportLayer = Layer.effect(
  CodexControlTransport,
  Effect.map(HttpClient.HttpClient, makeHttpClientCodexControlTransport)
)

export const makeFetchCodexControlTransport = (
  fetchImplementation: (request: Request) => Promise<Response> = fetch
): CodexControlTransportShape =>
  CodexControlTransport.of({
    execute: Effect.fn("CodexControlTransport.execute")(function* (request) {
      const response = yield* Effect.tryPromise({
        try: () => fetchImplementation(request),
        catch: transportFailure
      })
      return HttpClientResponse.fromWeb(HttpClientRequest.fromWeb(request), response)
    })
  })
