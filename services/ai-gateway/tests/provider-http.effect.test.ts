import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AIProviderHttp,
  AIProviderHttpError,
  AIProviderHttpLive,
  AIProviderHttpRequestInit,
  makeAIProviderHttpLive,
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

interface TransportCase {
  readonly cause: unknown;
  readonly expected: AIProviderHttpError["code"];
}

const transportCases: ReadonlyArray<TransportCase> = [
  {
    cause: { name: "TimeoutError", message: "private timeout" },
    expected: "provider_timeout",
  },
  {
    cause: { code: "ECONNRESET", message: "private reset" },
    expected: "provider_transport_failed",
  },
  {
    cause: new Error("private failure"),
    expected: "provider_unavailable",
  },
];

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

  it.effect("keeps credential-bearing redirects manual at the fetch boundary", () =>
    Effect.gen(function*() {
      const calls: Array<{
        readonly authorization: string | null;
        readonly redirect: RequestInit["redirect"] | "default";
        readonly url: string;
      }> = [];
      const fetchImpl = Object.assign(
        (input: string | Request | URL, init?: RequestInit) => {
          const request = input instanceof Request
            ? input
            : new Request(input.toString(), init);
          calls.push({
            authorization: new Headers(init?.headers).get("authorization"),
            redirect: init?.redirect ?? "default",
            url: request.url,
          });
          if (init?.redirect !== "manual") {
            calls.push({
              authorization: new Headers(init?.headers).get("authorization"),
              redirect: init?.redirect ?? "default",
              url: "https://redirect-target.invalid/v1/responses",
            });
          }
          return Promise.resolve(new Response(null, {
            status: 307,
            headers: { location: "https://redirect-target.invalid/v1/responses" },
          }));
        },
        { preconnect: globalThis["fetch"].preconnect },
      );
      const fetchLayer = FetchHttpClient.layer.pipe(
        Layer.provide(AIProviderHttpRequestInit),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
      );
      const layer = AIProviderHttpLive.pipe(
        Layer.provide(fetchLayer),
      );
      const provider = yield* AIProviderHttp.pipe(Effect.provide(layer));
      const response = yield* provider.execute(new Request(
        "https://api.openai.test/v1/responses",
        {
          method: "POST",
          headers: { authorization: "Bearer projected-workload-token" },
          body: "{}",
        },
      ));

      assert.strictEqual(response.status, 307);
      assert.deepStrictEqual(calls, [{
        authorization: "Bearer projected-workload-token",
        redirect: "manual",
        url: "https://api.openai.test/v1/responses",
      }]);
    }));

  it.effect("scopes manual redirects to the provider client", () =>
    Effect.gen(function*() {
      const redirects: Array<RequestInit["redirect"] | "default"> = [];
      const fetchImpl = Object.assign(
        (_input: string | Request | URL, init?: RequestInit) => {
          redirects.push(init?.redirect ?? "default");
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        { preconnect: globalThis["fetch"].preconnect },
      );
      const ordinaryClientLayer = FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
      );
      const provider = yield* AIProviderHttp.pipe(
        Effect.provide(makeAIProviderHttpLive(ordinaryClientLayer)),
      );
      const ordinaryClient = yield* HttpClient.HttpClient.pipe(
        Effect.provide(ordinaryClientLayer),
      );

      yield* Effect.scoped(
        HttpClient.withScope(ordinaryClient).execute(
          HttpClientRequest.get("https://api.openai.test/status"),
        ),
      );
      yield* provider.execute(new Request(
        "https://api.openai.test/v1/responses",
      ));

      assert.deepStrictEqual(redirects, ["default", "manual"]);
    }));

  it.effect("aborts the transport when the caller aborts before upstream headers", () =>
    Effect.gen(function*() {
      const transportSignal = yield* Deferred.make<AbortSignal>();
      const layer = providerLayer((_request, _url, signal) =>
        Deferred.succeed(transportSignal, signal).pipe(
          Effect.andThen(Effect.never),
        ));
      const controller = new AbortController();
      const provider = yield* AIProviderHttp.pipe(Effect.provide(layer));
      const fiber = yield* Effect.forkChild(Effect.exit(provider.execute(
        new Request("https://api.openai.test/v1/responses", {
          method: "POST",
          signal: controller.signal,
        }),
      )));
      const signal = yield* Deferred.await(transportSignal);
      yield* Effect.sync(() => controller.abort());
      const exit = yield* Fiber.join(fiber);

      assert.isFalse(Exit.isSuccess(exit));
      assert.isTrue(signal.aborted);
    }));

  it.effect("interrupts an in-flight provider stream when the caller aborts", () =>
    Effect.gen(function*() {
      const transportSignal = yield* Deferred.make<AbortSignal>();
      let bodyStarted = false;
      const layer = providerLayer((request, _url, signal) =>
        Deferred.succeed(transportSignal, signal).pipe(
          Effect.andThen(Effect.succeed(HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                bodyStarted = true;
                controller.enqueue(new Uint8Array([1]));
              },
            })),
          ))),
        ));
      const controller = new AbortController();
      const provider = yield* AIProviderHttp.pipe(Effect.provide(layer));
      const response = yield* provider.execute(new Request(
        "https://api.openai.test/v1/responses",
        { signal: controller.signal },
      ));
      const bodyFiber = yield* Effect.forkChild(Effect.exit(
        Stream.runDrain(response.body ?? Stream.empty),
      ));
      while (!bodyStarted) yield* Effect.yieldNow;
      const signal = yield* Deferred.await(transportSignal);
      yield* Effect.sync(() => controller.abort());
      const exit = yield* Fiber.join(bodyFiber);

      assert.isFalse(Exit.isSuccess(exit));
      assert.isTrue(signal.aborted);
    }));

  it.effect("maps request construction and transport failures to closed typed errors", () =>
    Effect.forEach(transportCases, ({ cause, expected }) =>
      Effect.gen(function*() {
        const transportLayer = providerLayer((request) => Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
        ));
        const transport = yield* Effect.gen(function*() {
          const provider = yield* AIProviderHttp;
          return yield* Effect.flip(provider.execute(
            new Request("https://api.openai.test/v1/responses"),
          ));
        }).pipe(Effect.provide(transportLayer));
        assert.instanceOf(transport, AIProviderHttpError);
        assert.strictEqual(transport.code, expected);
        assert.notInclude(String(transport), "private");
      }), { discard: true }).pipe(Effect.andThen(Effect.gen(function*() {

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
    }))));

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
      assert.strictEqual(failure.code, "provider_decode_failed");
      assert.notInclude(String(failure), "private provider payload");
    }));
});
