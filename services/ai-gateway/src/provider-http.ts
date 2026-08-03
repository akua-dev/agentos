import { classifyAIError } from "@akua-dev/agentos";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";

const AIProviderHttpErrorCode = Schema.Literals([
  "request_invalid",
  "provider_unavailable",
  "provider_timeout",
  "provider_transport_failed",
  "provider_protocol_failed",
  "provider_decode_failed",
  "provider_stream_failed",
]);

export class AIProviderHttpError extends Schema.TaggedErrorClass<AIProviderHttpError>()(
  "AIProviderHttpError",
  { code: AIProviderHttpErrorCode },
) {}

export class AIProviderHttp extends Context.Service<
  AIProviderHttp,
  {
    readonly execute: (
      request: Request,
    ) => Effect.Effect<AIProviderResponse, AIProviderHttpError>;
  }
>()("agentos/ai-gateway/AIProviderHttp") {}

export interface AIProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, AIProviderHttpError> | null;
}

export const AIProviderHttpLive = Layer.effect(
  AIProviderHttp,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const execute = Effect.fn("agentos.aiGateway.providerHttp.execute")(
      function*(request: Request) {
        const clientRequest = yield* Effect.try({
          try: () => HttpClientRequest.fromWeb(request),
          catch: () => providerHttpError("request_invalid"),
        });
        const response = yield* client.execute(clientRequest).pipe(
          Effect.mapError((error) => providerHttpError(httpErrorCode(error))),
        );
        const hasNoBody = request.method === "HEAD" ||
          response.status === 204 || response.status === 304;
        const body: AIProviderResponse["body"] = hasNoBody
          ? null
          : response.stream.pipe(
            Stream.mapError((error) =>
              providerHttpError(streamErrorCode(error))
            ),
          );
        return {
          status: response.status,
          headers: response.headers,
          body,
        } satisfies AIProviderResponse;
      },
    );
    return AIProviderHttp.of({ execute });
  }),
);

function providerHttpError(code: AIProviderHttpError["code"]) {
  return AIProviderHttpError.make({ code });
}

function httpErrorCode(
  error: HttpClientError.HttpClientError,
): AIProviderHttpError["code"] {
  switch (error.reason._tag) {
    case "EncodeError":
    case "InvalidUrlError":
      return "request_invalid";
    case "DecodeError":
    case "EmptyBodyError":
      return "provider_decode_failed";
    case "StatusCodeError":
      return "provider_protocol_failed";
    case "TransportError": {
      const failure = classifyAIError(error.reason.cause);
      if (failure === "timeout") return "provider_timeout";
      if (failure === "protocol") return "provider_protocol_failed";
      if (failure === "decode") return "provider_decode_failed";
      if (failure === "transport") return "provider_transport_failed";
      return "provider_unavailable";
    }
  }
}

function streamErrorCode(
  error: HttpClientError.HttpClientError,
): AIProviderHttpError["code"] {
  return error.reason._tag === "DecodeError" ||
      error.reason._tag === "EmptyBodyError"
    ? "provider_decode_failed"
    : "provider_stream_failed";
}
