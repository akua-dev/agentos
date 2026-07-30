import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse, type HttpServerError } from "effect/unstable/http"

export class WebRequestUnavailableError extends Schema.TaggedErrorClass<WebRequestUnavailableError>()(
  "WebRequestUnavailableError",
  {
    message: Schema.String
  }
) {}

export const decodeOriginalWebRequest: Effect.Effect<
  Request,
  WebRequestUnavailableError,
  HttpServerRequest.HttpServerRequest
> = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  request.source instanceof Request
    ? Effect.succeed(request.source)
    : Effect.fail(
        new WebRequestUnavailableError({
          message: "The HTTP runtime did not expose the original Web request"
        })
      )
)

export const originalWebRequest: Effect.Effect<
  Request,
  never,
  HttpServerRequest.HttpServerRequest
> = decodeOriginalWebRequest.pipe(Effect.orDie)

export const rawWebResponse = (response: Response): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(response)

export const makeRawWebHandler = <E, R>(
  handle: (request: Request) => Effect.Effect<Response, E, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> => originalWebRequest.pipe(Effect.flatMap(handle), Effect.map(rawWebResponse))

export type PortableHttpError = WebRequestUnavailableError | HttpServerError.HttpServerError
