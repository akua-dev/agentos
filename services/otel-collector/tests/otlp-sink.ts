import { Effect, Ref, Schema } from "effect";

import {
  acquireBunTestServer,
  readWebRequestBytes,
} from "../../../tooling/testing/bun-http.ts";

export interface OtlpSinkRequest {
  readonly path: string;
  readonly body: Uint8Array;
  readonly accepted: boolean;
  readonly credentialAuthorized: boolean;
  readonly responseStatus: number;
}

export interface OtlpTestSink {
  readonly requests: Effect.Effect<ReadonlyArray<OtlpSinkRequest>>;
  readonly remoteEndpoint: string;
  readonly setAvailable: (available: boolean) => Effect.Effect<void>;
  readonly setStatus: (status: number) => Effect.Effect<void>;
}

export class OtlpTestSinkError extends Schema.TaggedErrorClass<OtlpTestSinkError>()(
  "OtlpTestSinkError",
  { operation: Schema.Literal("decompress") },
) {}

const gunzip = Effect.fn("test.otlpSink.gunzip")((encoded: Uint8Array) =>
  Effect.tryPromise({
    try: () => {
      const compressed = Uint8Array.from(encoded);
      const stream = new Blob([compressed]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      );
      return new Response(stream).arrayBuffer().then(
        (buffer) => new Uint8Array(buffer),
      );
    },
    catch: () => OtlpTestSinkError.make({ operation: "decompress" }),
  })
);

export const acquireOtlpTestSink = Effect.fn("test.otlpSink.acquire")(
  function*(port?: number) {
    const status = yield* Ref.make(503);
    const requests = yield* Ref.make<ReadonlyArray<OtlpSinkRequest>>([]);
    const server = yield* acquireBunTestServer((request) =>
      Effect.gen(function*() {
        const encoded = yield* readWebRequestBytes(request);
        const body = request.headers.get("content-encoding")?.toLowerCase() ===
            "gzip"
          ? yield* gunzip(encoded)
          : encoded;
        const responseStatus = yield* Ref.get(status);
        const accepted = responseStatus >= 200 && responseStatus < 300;
        yield* Ref.update(requests, (current) => [...current, {
          path: new URL(request.url).pathname,
          body,
          accepted,
          credentialAuthorized:
            request.headers.get("x-agentos-test") === "bounded",
          responseStatus,
        }]);
        return new Response(null, { status: responseStatus });
      }),
      { hostname: "0.0.0.0", port },
    );
    return {
      requests: Ref.get(requests),
      remoteEndpoint: `http://host.docker.internal:${server.port}`,
      setAvailable: (value: boolean) => Ref.set(status, value ? 200 : 503),
      setStatus: (value: number) => Ref.set(status, value),
    } satisfies OtlpTestSink;
  },
);
