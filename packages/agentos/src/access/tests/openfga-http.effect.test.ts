import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AGENTOS_OPENFGA_HEALTH_OBJECT,
  AGENTOS_OPENFGA_HEALTH_RELATION,
  AGENTOS_OPENFGA_HEALTH_USER,
  AGENTOS_OPENFGA_STORE_NAME,
  AgentOSOpenFgaAuthorizationModelV1,
  OpenFgaAuthorizationApi,
  type OpenFgaApiCheckRequest,
  type OpenFgaApiTupleMutationRequest,
} from "../openfga.ts";
import {
  OpenFgaHttpError,
  OpenFgaHttpTransport,
  OpenFgaManagementApi,
  OpenFgaManagementError,
  OpenFgaAuthorizationApiHttpLayer,
  bootstrapOpenFgaAuthorization,
  makeOpenFgaHttpTransportLayer,
  type OpenFgaAuthorizationModelRecordV1,
  type OpenFgaStoreV1,
} from "../openfga-http.ts";

const StoreId = "01K1J6T8NS7B4K5AT9E1YH8D5R";
const ModelId = "01K1J6V6Z3S94FWX6H3M1TDME4";
const PreviousModelId = "01K1J6V0000000000000000000";

const canonicalModelRecord: OpenFgaAuthorizationModelRecordV1 = {
  id: ModelId,
  ...AgentOSOpenFgaAuthorizationModelV1,
};

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

function managementLayer(input?: {
  readonly stores?: ReadonlyArray<OpenFgaStoreV1>;
  readonly models?: ReadonlyArray<OpenFgaAuthorizationModelRecordV1>;
  readonly createdStoreId?: string;
  readonly writtenModelId?: string;
  readonly creates?: Ref.Ref<number>;
  readonly writes?: Ref.Ref<number>;
}) {
  return Layer.succeed(OpenFgaManagementApi)({
    listStores: () => Effect.succeed(input?.stores ?? []),
    createStore: () =>
      (input?.creates === undefined
        ? Effect.void
        : Ref.update(input.creates, (count) => count + 1)).pipe(
        Effect.as({
          id: input?.createdStoreId ?? StoreId,
          name: AGENTOS_OPENFGA_STORE_NAME,
        }),
      ),
    listAuthorizationModels: () => Effect.succeed(input?.models ?? []),
    writeAuthorizationModel: () =>
      (input?.writes === undefined
        ? Effect.void
        : Ref.update(input.writes, (count) => count + 1)).pipe(
        Effect.as(input?.writtenModelId ?? ModelId),
      ),
  });
}

function authorizationLayer(
  mutations: Ref.Ref<ReadonlyArray<OpenFgaApiTupleMutationRequest>>,
  checks: Ref.Ref<ReadonlyArray<OpenFgaApiCheckRequest>>,
  decisions: ReadonlyArray<boolean> = [true],
) {
  return Layer.effect(
    OpenFgaAuthorizationApi,
    Effect.gen(function*() {
      const decisionIndex = yield* Ref.make(0);
      return OpenFgaAuthorizationApi.of({
        mutateTuples: (request) =>
          Ref.update(mutations, (values) => [...values, request]),
        check: (request) =>
          Effect.gen(function*() {
            yield* Ref.update(checks, (values) => [...values, request]);
            const index = yield* Ref.getAndUpdate(
              decisionIndex,
              (value) => value + 1,
            );
            return decisions[index] ?? decisions.at(-1) ?? false;
          }),
      });
    }),
  );
}

describe("AgentOS OpenFGA HTTP and bootstrap", () => {
  it.effect("uses idempotent conflict handling and omits empty mutation groups", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const transport = Layer.succeed(OpenFgaHttpTransport)({
        request: (request) =>
          Ref.update(requests, (values) => [...values, request]).pipe(
            Effect.as({}),
          ),
      });
      const authorization = OpenFgaAuthorizationApiHttpLayer.pipe(
        Layer.provide(transport),
      );
      yield* Effect.gen(function*() {
        const api = yield* OpenFgaAuthorizationApi;
        yield* api.mutateTuples({
          storeId: StoreId,
          authorizationModelId: ModelId,
          mutation: {
            writes: [{
              user: AGENTOS_OPENFGA_HEALTH_USER,
              relation: AGENTOS_OPENFGA_HEALTH_RELATION,
              object: AGENTOS_OPENFGA_HEALTH_OBJECT,
              condition: null,
            }],
            deletes: [],
          },
        });
      }).pipe(Effect.provide(authorization));

      assert.deepNestedInclude((yield* Ref.get(requests))[0], {
        body: {
          authorization_model_id: ModelId,
          writes: {
            tuple_keys: [{
              user: AGENTOS_OPENFGA_HEALTH_USER,
              relation: AGENTOS_OPENFGA_HEALTH_RELATION,
              object: AGENTOS_OPENFGA_HEALTH_OBJECT,
            }],
            on_duplicate: "ignore",
          },
        },
      });
      const captured = yield* Schema.decodeUnknownEffect(Schema.Struct({
        body: Schema.Record(Schema.String, Schema.Unknown),
      }))((yield* Ref.get(requests))[0]);
      assert.notProperty(
        captured.body,
        "deletes",
      );
    }));

  it.effect("redacts the preshared key and never exposes an upstream body", () =>
    Effect.gen(function*() {
      const secret = "openfga-super-secret";
      const observedAuthorization = yield* Ref.make<string | null>(null);
      const transportLayer = makeOpenFgaHttpTransportLayer({
        baseUrl: "http://openfga.agentos-core.svc:8080",
        presharedKey: Redacted.make(secret),
        timeoutMillis: 1_000,
        maximumResponseBytes: 1_024,
      }).pipe(
        Layer.provide(httpClientLayer((request) =>
          Ref.set(
            observedAuthorization,
            request.headers.authorization ?? null,
          ).pipe(
            Effect.as(new Response(
              `sensitive upstream response containing ${secret}`,
              { status: 401 },
            )),
          )
        )),
      );

      const failure = yield* Effect.gen(function*() {
        const transport = yield* OpenFgaHttpTransport;
        return yield* transport.request({
          operation: "list_stores",
          method: "GET",
          path: "/stores",
        });
      }).pipe(Effect.provide(transportLayer), Effect.flip);

      assert.instanceOf(failure, OpenFgaHttpError);
      assert.strictEqual(failure.code, "unexpected_status");
      assert.strictEqual(failure.status, 401);
      assert.strictEqual(yield* Ref.get(observedAuthorization), `Bearer ${secret}`);
      assert.notInclude(String(failure), secret);
      assert.notInclude(JSON.stringify(failure), secret);
      assert.notInclude(String(failure), "sensitive upstream response");
    }));

  it.effect("reuses the exact immutable model and verifies canonical readiness strongly", () =>
    Effect.gen(function*() {
      const creates = yield* Ref.make(0);
      const writes = yield* Ref.make(0);
      const mutations = yield* Ref.make<ReadonlyArray<OpenFgaApiTupleMutationRequest>>([]);
      const checks = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);

      const result = yield* bootstrapOpenFgaAuthorization.pipe(
        Effect.provide(authorizationLayer(mutations, checks)),
        Effect.provide(managementLayer({
          stores: [{ id: StoreId, name: AGENTOS_OPENFGA_STORE_NAME }],
          models: [canonicalModelRecord],
          creates,
          writes,
        })),
      );

      assert.deepStrictEqual(result, {
        schemaVersion: 1,
        storeId: StoreId,
        authorizationModelId: ModelId,
        previousAuthorizationModelId: null,
        modelCreated: false,
      });
      assert.strictEqual(yield* Ref.get(creates), 0);
      assert.strictEqual(yield* Ref.get(writes), 0);
      assert.isEmpty(yield* Ref.get(mutations));
      assert.deepStrictEqual(yield* Ref.get(checks), [{
        storeId: StoreId,
        authorizationModelId: ModelId,
        user: AGENTOS_OPENFGA_HEALTH_USER,
        relation: AGENTOS_OPENFGA_HEALTH_RELATION,
        object: AGENTOS_OPENFGA_HEALTH_OBJECT,
        context: {},
        consistency: "HIGHER_CONSISTENCY",
      }]);
    }));

  it.effect("creates a missing model and preserves the prior model id for rollback", () =>
    Effect.gen(function*() {
      const writes = yield* Ref.make(0);
      const mutations = yield* Ref.make<ReadonlyArray<OpenFgaApiTupleMutationRequest>>([]);
      const checks = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);
      const prior: OpenFgaAuthorizationModelRecordV1 = {
        id: PreviousModelId,
        schema_version: "1.1",
        type_definitions: [{ type: "user" }],
        conditions: {},
      };

      const result = yield* bootstrapOpenFgaAuthorization.pipe(
        Effect.provide(authorizationLayer(mutations, checks, [false, true])),
        Effect.provide(managementLayer({
          stores: [{ id: StoreId, name: AGENTOS_OPENFGA_STORE_NAME }],
          models: [prior],
          writes,
          writtenModelId: ModelId,
        })),
      );

      assert.strictEqual(result.authorizationModelId, ModelId);
      assert.strictEqual(result.previousAuthorizationModelId, PreviousModelId);
      assert.isTrue(result.modelCreated);
      assert.strictEqual(yield* Ref.get(writes), 1);
      assert.deepStrictEqual(yield* Ref.get(mutations), [{
        storeId: StoreId,
        authorizationModelId: ModelId,
        mutation: {
          writes: [{
            user: AGENTOS_OPENFGA_HEALTH_USER,
            relation: AGENTOS_OPENFGA_HEALTH_RELATION,
            object: AGENTOS_OPENFGA_HEALTH_OBJECT,
            condition: null,
          }],
          deletes: [],
        },
      }]);
    }));

  it.effect("fails closed when the configured store name is ambiguous", () =>
    Effect.gen(function*() {
      const mutations = yield* Ref.make<ReadonlyArray<OpenFgaApiTupleMutationRequest>>([]);
      const checks = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);
      const failure = yield* bootstrapOpenFgaAuthorization.pipe(
        Effect.provide(authorizationLayer(mutations, checks)),
        Effect.provide(managementLayer({
          stores: [
            { id: StoreId, name: AGENTOS_OPENFGA_STORE_NAME },
            {
              id: "01K1J6T8NS7B4K5AT9E1YH8D5S",
              name: AGENTOS_OPENFGA_STORE_NAME,
            },
          ],
        })),
        Effect.flip,
      );
      assert.instanceOf(failure, OpenFgaManagementError);
      assert.strictEqual(failure.code, "ambiguous_store");
      assert.isEmpty(yield* Ref.get(mutations));
    }));
});
