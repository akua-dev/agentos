import { Context, Effect, Layer, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";

const AIProviderHttpErrorCode = Schema.Literals([
  "request_invalid",
  "provider_unavailable",
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
          Effect.mapError(() => providerHttpError("provider_unavailable")),
        );
        const hasNoBody = request.method === "HEAD" ||
          response.status === 204 || response.status === 304;
        const body: AIProviderResponse["body"] = hasNoBody
          ? null
          : response.stream.pipe(
            Stream.mapError(() =>
              providerHttpError("provider_stream_failed")
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
