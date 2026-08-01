import {
  Context,
  Effect,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
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
  OpenFgaDependencyUnavailable,
  type OpenFgaApiCheckRequest,
  type OpenFgaApiTupleMutationRequest,
  type OpenFgaAuthorizationModelV1,
  type OpenFgaTupleV1,
} from "./openfga.ts";

const OpenFgaId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/)),
);

const OpenFgaHttpOperation = Schema.Literals([
  "list_stores",
  "create_store",
  "list_models",
  "write_model",
  "mutate_tuples",
  "check",
]);

const OpenFgaHttpErrorCode = Schema.Literals([
  "invalid_configuration",
  "network_failure",
  "timeout",
  "unexpected_status",
  "response_too_large",
  "invalid_json",
]);

export class OpenFgaHttpError extends Schema.TaggedErrorClass<OpenFgaHttpError>()(
  "OpenFgaHttpError",
  {
    operation: OpenFgaHttpOperation,
    code: OpenFgaHttpErrorCode,
    status: Schema.NullOr(Schema.Number),
  },
) {}

const OpenFgaManagementErrorCode = Schema.Literals([
  "dependency_unavailable",
  "invalid_response",
  "pagination_limit",
  "ambiguous_store",
  "health_check_denied",
]);

export class OpenFgaManagementError extends Schema.TaggedErrorClass<OpenFgaManagementError>()(
  "OpenFgaManagementError",
  {
    operation: OpenFgaHttpOperation,
    code: OpenFgaManagementErrorCode,
  },
) {}

export interface OpenFgaHttpRequest {
  readonly operation: typeof OpenFgaHttpOperation.Type;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

export class OpenFgaHttpTransport extends Context.Service<
  OpenFgaHttpTransport,
  {
    readonly request: (
      request: OpenFgaHttpRequest,
    ) => Effect.Effect<unknown, OpenFgaHttpError>;
  }
>()("agentos/access/OpenFgaHttpTransport") {}

export interface OpenFgaHttpTransportOptions {
  readonly baseUrl: string;
  readonly presharedKey: Redacted.Redacted<string> | null;
  readonly timeoutMillis: number;
  readonly maximumResponseBytes: number;
}

export interface OpenFgaStoreV1 {
  readonly id: string;
  readonly name: string;
}

export interface OpenFgaAuthorizationModelRecordV1 {
  readonly id: string;
  readonly schema_version: "1.1";
  readonly type_definitions: ReadonlyArray<unknown>;
  readonly conditions: Readonly<Record<string, unknown>>;
}

export class OpenFgaManagementApi extends Context.Service<
  OpenFgaManagementApi,
  {
    readonly listStores: (
      name: string,
    ) => Effect.Effect<ReadonlyArray<OpenFgaStoreV1>, OpenFgaManagementError>;
    readonly createStore: (
      name: string,
    ) => Effect.Effect<OpenFgaStoreV1, OpenFgaManagementError>;
    readonly listAuthorizationModels: (
      storeId: string,
    ) => Effect.Effect<
      ReadonlyArray<OpenFgaAuthorizationModelRecordV1>,
      OpenFgaManagementError
    >;
    readonly writeAuthorizationModel: (
      storeId: string,
      model: OpenFgaAuthorizationModelV1,
    ) => Effect.Effect<string, OpenFgaManagementError>;
  }
>()("agentos/access/OpenFgaManagementApi") {}

export const OpenFgaBootstrapResultV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  storeId: OpenFgaId,
  authorizationModelId: OpenFgaId,
  previousAuthorizationModelId: Schema.NullOr(OpenFgaId),
  modelCreated: Schema.Boolean,
});

export type OpenFgaBootstrapResultV1 =
  typeof OpenFgaBootstrapResultV1Schema.Type;

const StoreSchema = Schema.Struct({
  id: OpenFgaId,
  name: Schema.String,
});
const StoreListResponseSchema = Schema.Struct({
  stores: Schema.Array(StoreSchema),
  continuation_token: Schema.optional(Schema.String),
});
const ModelRecordWireSchema = Schema.Struct({
  id: OpenFgaId,
  schema_version: Schema.Literal("1.1"),
  type_definitions: Schema.Array(Schema.Unknown),
  conditions: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown),
  ),
});
const ModelListResponseSchema = Schema.Struct({
  authorization_models: Schema.Array(ModelRecordWireSchema),
  continuation_token: Schema.optional(Schema.String),
});
const WriteModelResponseSchema = Schema.Struct({
  authorization_model_id: OpenFgaId,
});
const CheckResponseSchema = Schema.Struct({ allowed: Schema.Boolean });

const MaximumPaginationPages = 100;

export function makeOpenFgaHttpTransportLayer(
  options: OpenFgaHttpTransportOptions,
) {
  return Layer.effect(
    OpenFgaHttpTransport,
    Effect.gen(function*() {
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      return OpenFgaHttpTransport.of({
        request: Effect.fn("agentos.openfga.http.request")(function*(request) {
          const base = yield* Effect.try({
            try: () => new URL(options.baseUrl),
            catch: () => httpError(
              request.operation,
              "invalid_configuration",
              null,
            ),
          });
          if (base.protocol !== "http:" && base.protocol !== "https:") {
            return yield* httpError(
              request.operation,
              "invalid_configuration",
              null,
            );
          }
          const url = yield* Effect.try({
            try: () => new URL(request.path, ensureTrailingSlash(base)),
            catch: () => httpError(
              request.operation,
              "invalid_configuration",
              null,
            ),
          });

          let clientRequest = HttpClientRequest.make(request.method)(url).pipe(
            HttpClientRequest.acceptJson,
          );
          if (options.presharedKey !== null) {
            clientRequest = HttpClientRequest.setHeader(
              clientRequest,
              "authorization",
              `Bearer ${Redacted.value(options.presharedKey)}`,
            );
          }
          if (request.body !== undefined) {
            clientRequest = yield* HttpClientRequest.bodyJson(
              clientRequest,
              request.body,
            ).pipe(
              Effect.mapError(() =>
                httpError(request.operation, "invalid_configuration", null)
              ),
            );
          }
          const requestEffect = client.execute(clientRequest).pipe(
            Effect.mapError(() =>
              httpError(request.operation, "network_failure", null)
            ),
            Effect.flatMap((response) => {
              if (response.status < 200 || response.status >= 300) {
                return httpError(
                  request.operation,
                  "unexpected_status",
                  response.status,
                );
              }
              return readBoundedJsonResponse(
                response,
                request.operation,
                options.maximumResponseBytes,
              );
            }),
          );

          return yield* requestEffect.pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMillis,
              orElse: () =>
                httpError(request.operation, "timeout", null),
            }),
            Effect.scoped,
          );
        }),
      });
    }),
  );
}

export const OpenFgaManagementApiHttpLayer = Layer.effect(
  OpenFgaManagementApi,
  Effect.gen(function*() {
    const transport = yield* OpenFgaHttpTransport;
    return OpenFgaManagementApi.of({
      listStores: Effect.fn("agentos.openfga.listStores")(function*(name) {
        const stores: Array<OpenFgaStoreV1> = [];
        let token = "";
        const seen = new Set<string>();
        for (let page = 0; page < MaximumPaginationPages; page += 1) {
          const query = new URLSearchParams({ name, page_size: "100" });
          if (token !== "") query.set("continuation_token", token);
          const response = yield* transport.request({
            operation: "list_stores",
            method: "GET",
            path: `/stores?${query.toString()}`,
          }).pipe(mapHttpManagementError("list_stores"));
          const decoded = yield* decodeManagementResponse(
            StoreListResponseSchema,
            response,
            "list_stores",
          );
          stores.push(...decoded.stores);
          token = decoded.continuation_token ?? "";
          if (token === "") return stores;
          if (seen.has(token)) {
            return yield* managementError("list_stores", "pagination_limit");
          }
          seen.add(token);
        }
        return yield* managementError("list_stores", "pagination_limit");
      }),
      createStore: Effect.fn("agentos.openfga.createStore")(function*(name) {
        const response = yield* transport.request({
          operation: "create_store",
          method: "POST",
          path: "/stores",
          body: { name },
        }).pipe(mapHttpManagementError("create_store"));
        return yield* decodeManagementResponse(
          StoreSchema,
          response,
          "create_store",
        );
      }),
      listAuthorizationModels: Effect.fn(
        "agentos.openfga.listAuthorizationModels",
      )(function*(storeId) {
        const models: Array<OpenFgaAuthorizationModelRecordV1> = [];
        let token = "";
        const seen = new Set<string>();
        for (let page = 0; page < MaximumPaginationPages; page += 1) {
          const query = new URLSearchParams({ page_size: "100" });
          if (token !== "") query.set("continuation_token", token);
          const response = yield* transport.request({
            operation: "list_models",
            method: "GET",
            path: `/stores/${encodeURIComponent(storeId)}/authorization-models?${query.toString()}`,
          }).pipe(mapHttpManagementError("list_models"));
          const decoded = yield* decodeManagementResponse(
            ModelListResponseSchema,
            response,
            "list_models",
          );
          for (const model of decoded.authorization_models) {
            models.push({
              id: model.id,
              schema_version: model.schema_version,
              type_definitions: model.type_definitions,
              conditions: model.conditions ?? {},
            });
          }
          token = decoded.continuation_token ?? "";
          if (token === "") return models;
          if (seen.has(token)) {
            return yield* managementError("list_models", "pagination_limit");
          }
          seen.add(token);
        }
        return yield* managementError("list_models", "pagination_limit");
      }),
      writeAuthorizationModel: Effect.fn(
        "agentos.openfga.writeAuthorizationModel",
      )(function*(storeId, model) {
        const response = yield* transport.request({
          operation: "write_model",
          method: "POST",
          path: `/stores/${encodeURIComponent(storeId)}/authorization-models`,
          body: model,
        }).pipe(mapHttpManagementError("write_model"));
        const decoded = yield* decodeManagementResponse(
          WriteModelResponseSchema,
          response,
          "write_model",
        );
        return decoded.authorization_model_id;
      }),
    });
  }),
);

export const OpenFgaAuthorizationApiHttpLayer = Layer.effect(
  OpenFgaAuthorizationApi,
  Effect.gen(function*() {
    const transport = yield* OpenFgaHttpTransport;
    return OpenFgaAuthorizationApi.of({
      mutateTuples: Effect.fn("agentos.openfga.http.mutateTuples")(
        function*(request) {
          if (
            request.mutation.writes.length === 0 &&
            request.mutation.deletes.length === 0
          ) return;
          yield* transport.request({
            operation: "mutate_tuples",
            method: "POST",
            path: `/stores/${encodeURIComponent(request.storeId)}/write`,
            body: {
              authorization_model_id: request.authorizationModelId,
              ...(request.mutation.writes.length === 0
                ? {}
                : {
                  writes: {
                    tuple_keys: request.mutation.writes.map(toWireTuple),
                    on_duplicate: "ignore",
                  },
                }),
              ...(request.mutation.deletes.length === 0
                ? {}
                : {
                  deletes: {
                    tuple_keys: request.mutation.deletes,
                    on_missing: "ignore",
                  },
                }),
            },
          }).pipe(
            Effect.mapError(() =>
              OpenFgaDependencyUnavailable.make({
                operation: "mutate_tuples",
              })
            ),
            Effect.asVoid,
          );
        },
      ),
      check: Effect.fn("agentos.openfga.http.check")(function*(request) {
        const response = yield* transport.request({
          operation: "check",
          method: "POST",
          path: `/stores/${encodeURIComponent(request.storeId)}/check`,
          body: {
            authorization_model_id: request.authorizationModelId,
            tuple_key: {
              user: request.user,
              relation: request.relation,
              object: request.object,
            },
            context: request.context,
            consistency: request.consistency,
          },
        }).pipe(
          Effect.mapError(() =>
            OpenFgaDependencyUnavailable.make({ operation: "check" })
          ),
        );
        return yield* Schema.decodeUnknownEffect(CheckResponseSchema)(response)
          .pipe(
            Effect.map((decoded) => decoded.allowed),
            Effect.mapError(() =>
              OpenFgaDependencyUnavailable.make({ operation: "check" })
            ),
          );
      }),
    });
  }),
);

export const bootstrapOpenFgaAuthorization = Effect.gen(function*() {
  const management = yield* OpenFgaManagementApi;
  const authorization = yield* OpenFgaAuthorizationApi;
  const matchingStores = (yield* management.listStores(
    AGENTOS_OPENFGA_STORE_NAME,
  )).filter(({ name }) => name === AGENTOS_OPENFGA_STORE_NAME);
  if (matchingStores.length > 1) {
    return yield* managementError("list_stores", "ambiguous_store");
  }
  const store = matchingStores[0] ??
    (yield* management.createStore(AGENTOS_OPENFGA_STORE_NAME));
  const models = yield* management.listAuthorizationModels(store.id);
  const matchingModel = models.find((model) =>
    authorizationModelsEqual(model, AgentOSOpenFgaAuthorizationModelV1)
  );
  const previousAuthorizationModelId = matchingModel === undefined
    ? models[0]?.id ?? null
    : null;
  const authorizationModelId = matchingModel?.id ??
    (yield* management.writeAuthorizationModel(
      store.id,
      AgentOSOpenFgaAuthorizationModelV1,
    ));
  const deployment = {
    storeId: store.id,
    authorizationModelId,
  };
  const healthCheck: OpenFgaApiCheckRequest = {
    ...deployment,
    user: AGENTOS_OPENFGA_HEALTH_USER,
    relation: AGENTOS_OPENFGA_HEALTH_RELATION,
    object: AGENTOS_OPENFGA_HEALTH_OBJECT,
    context: {},
    consistency: "HIGHER_CONSISTENCY",
  };
  if (!(yield* authorization.check(healthCheck))) {
    const mutation: OpenFgaApiTupleMutationRequest = {
      ...deployment,
      mutation: {
        writes: [{
          user: AGENTOS_OPENFGA_HEALTH_USER,
          relation: AGENTOS_OPENFGA_HEALTH_RELATION,
          object: AGENTOS_OPENFGA_HEALTH_OBJECT,
          condition: null,
        }],
        deletes: [],
      },
    };
    yield* authorization.mutateTuples(mutation);
    if (!(yield* authorization.check(healthCheck))) {
      return yield* managementError("check", "health_check_denied");
    }
  }
  return {
    schemaVersion: 1,
    ...deployment,
    previousAuthorizationModelId,
    modelCreated: matchingModel === undefined,
  } satisfies OpenFgaBootstrapResultV1;
});

function ensureTrailingSlash(url: URL) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function httpError(
  operation: typeof OpenFgaHttpOperation.Type,
  code: typeof OpenFgaHttpErrorCode.Type,
  status: number | null,
) {
  return OpenFgaHttpError.make({ operation, code, status });
}

function managementError(
  operation: typeof OpenFgaHttpOperation.Type,
  code: typeof OpenFgaManagementErrorCode.Type,
) {
  return OpenFgaManagementError.make({ operation, code });
}

function mapHttpManagementError(
  operation: typeof OpenFgaHttpOperation.Type,
) {
  return Effect.mapError(() =>
    OpenFgaManagementError.make({
      operation,
      code: "dependency_unavailable",
    })
  );
}

function decodeManagementResponse<S extends Schema.Top>(
  schema: S,
  value: unknown,
  operation: typeof OpenFgaHttpOperation.Type,
) {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      OpenFgaManagementError.make({
        operation,
        code: "invalid_response",
      })
    ),
  );
}

function readBoundedJsonResponse(
  response: HttpClientResponse.HttpClientResponse,
  operation: typeof OpenFgaHttpOperation.Type,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    return Effect.fail(
      httpError(operation, "response_too_large", response.status),
    );
  }
  return response.stream.pipe(
    Stream.runFoldEffect(
      emptyBoundedResponseBody,
      (state, chunk) => {
        const length = state.length + chunk.byteLength;
        if (length > maximumResponseBytes) {
          return Effect.fail(
            httpError(operation, "response_too_large", response.status),
          );
        }
        return Effect.succeed({
          chunks: [...state.chunks, chunk],
          length,
        });
      },
    ),
    Effect.mapError((error) =>
      error instanceof OpenFgaHttpError
        ? error
        : httpError(operation, "network_failure", response.status)
    ),
    Effect.map(decodeBoundedResponseBody),
    Effect.flatMap((body) => {
      if (body.length === 0) return Effect.succeed(null);
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(body).pipe(
        Effect.mapError(() =>
          httpError(operation, "invalid_json", response.status)
        ),
      );
    }),
  );
}

interface BoundedResponseBody {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
}

function emptyBoundedResponseBody(): BoundedResponseBody {
  return { chunks: [], length: 0 };
}

function decodeBoundedResponseBody(body: BoundedResponseBody) {
  const bytes = new Uint8Array(body.length);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function toWireTuple(tuple: OpenFgaTupleV1) {
  if (tuple.condition === null) {
    const { condition: _condition, ...plain } = tuple;
    return plain;
  }
  return tuple;
}

function authorizationModelsEqual(
  record: OpenFgaAuthorizationModelRecordV1,
  model: OpenFgaAuthorizationModelV1,
) {
  const { id: _id, ...stored } = record;
  return stableJson(normalizeOpenFgaModel(stored)) ===
    stableJson(normalizeOpenFgaModel(model));
}

function normalizeOpenFgaModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOpenFgaModel(item));
  }
  if (typeof value !== "object" || value === null) return value;
  const normalized: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (
      (child === null && (childKey === "metadata" || childKey === "source_info")) ||
      (child === "" &&
        (childKey === "condition" || childKey === "module" || childKey === "object")) ||
      (Array.isArray(child) && child.length === 0 && childKey === "generic_types") ||
      (isEmptyRecord(child) && childKey === "relations")
    ) continue;
    normalized[childKey] = normalizeOpenFgaModel(child);
  }
  return normalized;
}

function isEmptyRecord(value: unknown): value is Readonly<Record<string, never>> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.keys(value).length === 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${stableJson(child)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
