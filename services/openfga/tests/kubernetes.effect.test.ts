import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Ref } from "effect";

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

describe("OpenFGA Kubernetes publication", () => {
  it.effect("creates a versioned deployment ConfigMap without publishing credentials", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly url: string;
        readonly method: string;
        readonly authorization: string | null;
        readonly body: unknown;
      }>>([]);
      const responses = [
        new Response("not found", { status: 404 }),
        new Response("{}", { status: 201 }),
      ];
      const secret = "kubernetes-service-account-secret";
      yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make(secret),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
        fetchImpl: (input, init) => {
          const headers = new Headers(init?.headers);
          return Effect.runPromise(Ref.update(requests, (values) => [
            ...values,
            {
              url: String(input),
              method: init?.method ?? "GET",
              authorization: headers.get("authorization"),
              body: init?.body === undefined
                ? null
                : JSON.parse(String(init.body)),
            },
          ])).then(() => responses.shift() ?? new Response(null, { status: 500 }));
        },
      }, result);

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
      const requests = yield* Ref.make<ReadonlyArray<{ method: string; body: any }>>([]);
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
      const responses = [
        new Response(JSON.stringify(existing), { status: 200 }),
        new Response("conflict details must remain private", { status: 409 }),
        new Response(JSON.stringify({
          ...existing,
          metadata: { ...existing.metadata, resourceVersion: "42" },
        }), { status: 200 }),
        new Response("{}", { status: 200 }),
      ];
      yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make("token"),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
        fetchImpl: (_input, init) => {
          const body = init?.body === undefined ? null : JSON.parse(String(init.body));
          return Effect.runPromise(Ref.update(requests, (values) => [
            ...values,
            { method: init?.method ?? "GET", body },
          ])).then(() => responses.shift() ?? new Response(null, { status: 500 }));
        },
      }, result);

      const captured = yield* Ref.get(requests);
      assert.deepStrictEqual(captured.map(({ method }) => method), [
        "GET",
        "PUT",
        "GET",
        "PUT",
      ]);
      assert.strictEqual(captured[1]?.body.metadata.resourceVersion, "41");
      assert.strictEqual(captured[3]?.body.metadata.resourceVersion, "42");
    }));

  it.effect("reports only stable codes when the API fails", () =>
    Effect.gen(function*() {
      const failure = yield* publishOpenFgaDeployment({
        apiBaseUrl: "https://kubernetes.default.svc",
        namespace: "agentos",
        serviceAccountToken: Redacted.make("do-not-leak"),
        timeoutMillis: 1_000,
        maximumResponseBytes: 64 * 1_024,
        fetchImpl: () => Promise.resolve(new Response(
          "sensitive Kubernetes response do-not-leak",
          { status: 403 },
        )),
      }, result).pipe(Effect.flip);
      assert.instanceOf(failure, OpenFgaKubernetesError);
      assert.strictEqual(failure.code, "unexpected_status");
      assert.notInclude(String(failure), "do-not-leak");
      assert.notInclude(JSON.stringify(failure), "sensitive Kubernetes response");
    }));
});
