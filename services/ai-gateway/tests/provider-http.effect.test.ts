import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AIProviderHttp,
  AIProviderHttpError,
  AIProviderHttpLive,
} from "../src/provider-http.ts";

function providerLayer(
  execute: Parameters<typeof HttpClient.make>[0],
) {
  return AIProviderHttpLive.pipe(
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(execute),
    )),
  );
}

describe("AI provider HTTP adapter", () => {
  it.effect("preserves the provider response while keeping transport inside Effect", () =>
    Effect.gen(function*() {
      const observed = yield* Ref.make<{
        readonly method: string;
        readonly authorization: string | undefined;
        readonly url: string;
      } | undefined>(undefined);
      const layer = providerLayer((request) =>
        Ref.set(observed, {
          method: request.method,
          authorization: request.headers.authorization,
          url: Option.getOrUndefined(
            HttpClientRequest.toUrl(request),
          )?.toString() ?? "invalid",
        }).pipe(
          Effect.as(HttpClientResponse.fromWeb(
            request,
            new Response("provider-stream", {
              status: 202,
              headers: { "x-provider-request-id": "provider-1" },
            }),
          )),
        ));
      const response = yield* Effect.gen(function*() {
        const provider = yield* AIProviderHttp;
        return yield* provider.execute(new Request(
          "https://api.openai.test/v1/responses?trace=1",
          {
            method: "POST",
            headers: { authorization: "Bearer provider-secret" },
            body: "request-body",
          },
        ));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(response.status, 202);
      assert.strictEqual(response.headers["x-provider-request-id"], "provider-1");
      assert.isNotNull(response.body);
      assert.strictEqual(
        yield* (response.body ?? Stream.empty).pipe(
          Stream.decodeText(),
          Stream.runFold(() => "", (text, chunk) => `${text}${chunk}`),
        ),
        "provider-stream",
      );
      assert.deepStrictEqual(yield* Ref.get(observed), {
        method: "POST",
        authorization: "Bearer provider-secret",
        url: "https://api.openai.test/v1/responses?trace=1",
      });
    }));

  it.effect("maps request construction and transport failures to closed typed errors", () =>
    Effect.gen(function*() {
      const transportLayer = providerLayer((request) => Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "private failure",
          }),
        }),
      ));
      const transport = yield* Effect.gen(function*() {
        const provider = yield* AIProviderHttp;
        return yield* Effect.flip(provider.execute(
          new Request("https://api.openai.test/v1/responses"),
        ));
      }).pipe(Effect.provide(transportLayer));
      assert.instanceOf(transport, AIProviderHttpError);
      assert.strictEqual(transport.code, "provider_unavailable");

      const provider = yield* AIProviderHttp.pipe(
        Effect.provide(AIProviderHttpLive),
        Effect.provide(Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(
              request,
              new Response("unused"),
            ))),
        )),
      );
      const invalidRequest = Object.create(Request.prototype);
      const invalid = yield* Effect.flip(provider.execute(invalidRequest));
      assert.instanceOf(invalid, AIProviderHttpError);
      assert.strictEqual(invalid.code, "request_invalid");
    }));

  it.effect("keeps provider stream defects typed and payload-free", () =>
    Effect.gen(function*() {
      const layer = providerLayer((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("private provider payload"));
            },
          })),
        )));
      const response = yield* Effect.gen(function*() {
        const provider = yield* AIProviderHttp;
        return yield* provider.execute(
          new Request("https://api.openai.test/v1/responses"),
        );
      }).pipe(Effect.provide(layer));
      assert.isNotNull(response.body);
      const failure = yield* Effect.flip(
        Stream.runDrain(response.body ?? Stream.empty),
      );
      assert.instanceOf(failure, AIProviderHttpError);
      assert.strictEqual(failure.code, "provider_stream_failed");
      assert.notInclude(String(failure), "private provider payload");
    }));
});
