import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { OpenFgaBootstrapResultV1 } from "../../../packages/agentos/src/access/openfga-http.ts";
import {
  OpenFgaKubernetesError,
  publishOpenFgaDeployment,
} from "../src/kubernetes.ts";

const result: OpenFgaBootstrapResultV1 = {
  schemaVersion: 1,
  storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
  authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
  previousAuthorizationModelId: "01K1J6V0000000000000000000",
  modelCreated: true,
};

const UpdateBodySchema = Schema.Struct({
  metadata: Schema.Struct({ resourceVersion: Schema.String }),
});

function httpClientLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      execute(request).pipe(
        Effect.map((response) =>
          HttpClientResponse.fromWeb(request, response)
        ),
      )
    ),
  );
}

function decodeRequestBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") return Effect.succeed(null);
  return Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);
}

function takeResponse(responses: Ref.Ref<ReadonlyArray<Response>>) {
  return Ref.modify(responses, (current) => [
    current[0] ?? new Response(null, { status: 500 }),
    current.slice(1),
  ]);
}

describe("OpenFGA Kubernetes publication", () => {
  it.effect("creates a versioned deployment ConfigMap without publishing credentials", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly url: string;
        readonly method: string;
        readonly authorization: string | null;
        readonly body: unknown;
      }>>([]);
      const responses = yield* Ref.make<ReadonlyArray<Response>>([
        new Response("not found", { status: 404 }),
        new Response("{}", { status: 201 }),
      ]);
      const secret = "kubernetes-service-account-secret";
      const client = httpClientLayer((request) =>
        Effect.gen(function*() {
          const body = yield* decodeRequestBody(request);
          yield* Ref.update(requests, (values) => [
            ...values,
            {
              url: request.url,
              method: request.method,
              authorization: request.headers.authorization ?? null,
              body,
            },
          ]);
          return yield* takeResponse(responses);
        })
      );
      yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make(secret),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
      }, result).pipe(Effect.provide(client));

      const captured = yield* Ref.get(requests);
      assert.lengthOf(captured, 2);
      assert.strictEqual(captured[0]?.method, "GET");
      assert.strictEqual(captured[1]?.method, "POST");
      assert.strictEqual(
        captured[1]?.url,
        "https://kubernetes.default.svc/api/v1/namespaces/agentos/configmaps",
      );
      assert.strictEqual(captured[1]?.authorization, `Bearer ${secret}`);
      assert.deepStrictEqual(captured[1]?.body, {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "openfga-deployment",
          namespace: "agentos",
          labels: {
            "app.kubernetes.io/name": "openfga",
            "app.kubernetes.io/component": "authorization-model",
            "app.kubernetes.io/part-of": "agentos",
            "agentos.akua.dev/model-version": "agentos-access-v1",
          },
        },
        data: {
          "authorization-model-id": result.authorizationModelId,
          "model-created": "true",
          "model-version": "agentos-access-v1",
          "previous-authorization-model-id": result.previousAuthorizationModelId,
          "store-id": result.storeId,
        },
      });
      assert.notInclude(JSON.stringify(captured[1]?.body), secret);
    }));

  it.effect("updates with resourceVersion and retries an optimistic conflict", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly method: string;
        readonly body: unknown;
      }>>([]);
      const existing = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "openfga-deployment",
          namespace: "agentos",
          resourceVersion: "41",
        },
        data: {},
      };
      const responses = yield* Ref.make<ReadonlyArray<Response>>([
        new Response(JSON.stringify(existing), { status: 200 }),
        new Response("conflict details must remain private", { status: 409 }),
        new Response(JSON.stringify({
          ...existing,
          metadata: { ...existing.metadata, resourceVersion: "42" },
        }), { status: 200 }),
        new Response("{}", { status: 200 }),
      ]);
      const client = httpClientLayer((request) =>
        Effect.gen(function*() {
          const body = yield* decodeRequestBody(request);
          yield* Ref.update(requests, (values) => [
            ...values,
            { method: request.method, body },
          ]);
          return yield* takeResponse(responses);
        })
      );
      yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make("token"),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
      }, result).pipe(Effect.provide(client));

      const captured = yield* Ref.get(requests);
      assert.deepStrictEqual(captured.map(({ method }) => method), [
        "GET",
        "PUT",
        "GET",
        "PUT",
      ]);
      const firstUpdate = yield* Schema.decodeUnknownEffect(UpdateBodySchema)(
        captured[1]?.body,
      );
      const secondUpdate = yield* Schema.decodeUnknownEffect(UpdateBodySchema)(
        captured[3]?.body,
      );
      assert.strictEqual(firstUpdate.metadata.resourceVersion, "41");
      assert.strictEqual(secondUpdate.metadata.resourceVersion, "42");
    }));

  it.effect("reports only stable codes when the API fails", () =>
    Effect.gen(function*() {
      const client = httpClientLayer(() =>
        Effect.succeed(new Response(
          "sensitive Kubernetes response do-not-leak",
          { status: 403 },
        ))
      );
      const failure = yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make("do-not-leak"),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
      }, result).pipe(Effect.provide(client), Effect.flip);
      assert.instanceOf(failure, OpenFgaKubernetesError);
      assert.strictEqual(failure.code, "unexpected_status");
      assert.notInclude(String(failure), "do-not-leak");
      assert.notInclude(JSON.stringify(failure), "sensitive Kubernetes response");
    }));
});
