import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { acquireBunTestServer } from "../bun-http.ts";

layer(Layer.merge(BunHttpClient.layer, Layer.empty))(
  "Bun HTTP test host adapter",
  (it) => {
    it.effect("scopes a server around an Effect request program", () =>
      Effect.scoped(Effect.gen(function*() {
        const server = yield* acquireBunTestServer((request) =>
          Effect.succeed(new Response(new URL(request.url).pathname))
        );
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(
          `http://127.0.0.1:${server.port}/effect-host`,
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(yield* response.text, "/effect-host");
      })));
  },
);
