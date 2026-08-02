import { Effect, Ref, Schema } from "effect";

import {
  acquireBunTestServer,
  readWebRequestBytes,
} from "../../../tooling/testing/bun-http.ts";

export interface OtlpSinkRequest {
  readonly path: string;
  readonly body: Uint8Array;
  readonly accepted: boolean;
}

export interface OtlpTestSink {
  readonly requests: Effect.Effect<ReadonlyArray<OtlpSinkRequest>>;
  readonly remoteEndpoint: string;
  readonly setAvailable: (available: boolean) => Effect.Effect<void>;
}

export class OtlpTestSinkError extends Schema.TaggedErrorClass<OtlpTestSinkError>()(
  "OtlpTestSinkError",
  { operation: Schema.Literal("decompress") },
) {}

export const acquireOtlpTestSink = Effect.fn("test.otlpSink.acquire")(
  function*() {
    const available = yield* Ref.make(false);
    const requests = yield* Ref.make<ReadonlyArray<OtlpSinkRequest>>([]);
    const server = yield* acquireBunTestServer((request) =>
      Effect.gen(function*() {
        const encoded = yield* readWebRequestBytes(request);
        const body = request.headers.get("content-encoding")?.toLowerCase() ===
            "gzip"
          ? yield* Effect.try({
              try: () => Bun.gunzipSync(encoded),
              catch: () => OtlpTestSinkError.make({ operation: "decompress" }),
            })
          : encoded;
        const accepted = yield* Ref.get(available);
        yield* Ref.update(requests, (current) => [...current, {
          path: new URL(request.url).pathname,
          body,
          accepted,
        }]);
        return new Response(null, { status: accepted ? 200 : 503 });
      }),
      { hostname: "0.0.0.0" },
    );
    return {
      requests: Ref.get(requests),
      remoteEndpoint: `http://host.docker.internal:${server.port}`,
      setAvailable: (value: boolean) => Ref.set(available, value),
    } satisfies OtlpTestSink;
  },
);
