import { Effect, Redacted, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { AGENTOS_OPENFGA_MODEL_VERSION } from "../../../packages/agentos/src/access/openfga.ts";
import type { OpenFgaBootstrapResultV1 } from "../../../packages/agentos/src/access/openfga-http.ts";

const KubernetesOperation = Schema.Literals([
  "get_configmap",
  "create_configmap",
  "update_configmap",
]);
const KubernetesErrorCode = Schema.Literals([
  "invalid_configuration",
  "network_failure",
  "timeout",
  "unexpected_status",
  "response_too_large",
  "invalid_response",
  "conflict_retry_exhausted",
]);

export class OpenFgaKubernetesError extends Schema.TaggedErrorClass<OpenFgaKubernetesError>()(
  "OpenFgaKubernetesError",
  {
    operation: KubernetesOperation,
    code: KubernetesErrorCode,
    status: Schema.NullOr(Schema.Number),
  },
) {}

export interface OpenFgaKubernetesOptions {
  readonly apiBaseUrl: string;
  readonly namespace: string;
  readonly serviceAccountToken: Redacted.Redacted<string>;
  readonly timeoutMillis: number;
  readonly maximumResponseBytes: number;
}

const ExistingConfigMapSchema = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("ConfigMap"),
  metadata: Schema.Struct({
    name: Schema.Literal("openfga-deployment"),
    namespace: Schema.String,
    resourceVersion: Schema.String,
  }),
  data: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const MaximumConflictRetries = 5;

export const publishOpenFgaDeployment = Effect.fn(
  "agentos.openfga.publishDeployment",
)(function*(
  options: OpenFgaKubernetesOptions,
  deployment: OpenFgaBootstrapResultV1,
) {
  const endpoint = yield* configMapEndpoints(options);
  for (let attempt = 0; attempt < MaximumConflictRetries; attempt += 1) {
    const existingResponse = yield* kubernetesRequest(options, {
      operation: "get_configmap",
      method: "GET",
      url: endpoint.item,
      acceptedStatuses: [200, 404],
    });
    if (existingResponse.status === 404) {
      const createResponse = yield* kubernetesRequest(options, {
        operation: "create_configmap",
        method: "POST",
        url: endpoint.collection,
        body: deploymentConfigMap(options.namespace, deployment),
        acceptedStatuses: [200, 201, 409],
      });
      if (createResponse.status === 409) continue;
      return;
    }
    const existing = yield* Schema.decodeUnknownEffect(
      ExistingConfigMapSchema,
      { onExcessProperty: "ignore" },
    )(existingResponse.body).pipe(
      Effect.mapError(() =>
        kubernetesError("get_configmap", "invalid_response", 200)
      ),
    );
    const updateResponse = yield* kubernetesRequest(options, {
      operation: "update_configmap",
      method: "PUT",
      url: endpoint.item,
      body: deploymentConfigMap(
        options.namespace,
        deployment,
        existing.metadata.resourceVersion,
      ),
      acceptedStatuses: [200, 409],
    });
    if (updateResponse.status === 409) continue;
    return;
  }
  return yield* kubernetesError(
    "update_configmap",
    "conflict_retry_exhausted",
    409,
  );
});

function configMapEndpoints(options: OpenFgaKubernetesOptions) {
  return Effect.try({
    try: () => new URL(options.apiBaseUrl),
    catch: () =>
      kubernetesError(
        "get_configmap",
        "invalid_configuration",
        null,
      ),
  }).pipe(
    Effect.flatMap((base) => {
      if (base.protocol !== "https:" && base.protocol !== "http:") {
        return kubernetesError(
          "get_configmap",
          "invalid_configuration",
          null,
        );
      }
      const namespace = encodeURIComponent(options.namespace);
      const collection = new URL(
        `/api/v1/namespaces/${namespace}/configmaps`,
        base,
      );
      return Effect.succeed({
        collection,
        item: new URL(`${collection.pathname}/openfga-deployment`, base),
      });
    }),
  );
}

function deploymentConfigMap(
  namespace: string,
  deployment: OpenFgaBootstrapResultV1,
  resourceVersion?: string,
) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "openfga-deployment",
      namespace,
      ...(resourceVersion === undefined ? {} : { resourceVersion }),
      labels: {
        "app.kubernetes.io/name": "openfga",
        "app.kubernetes.io/component": "authorization-model",
        "app.kubernetes.io/part-of": "agentos",
        "agentos.akua.dev/model-version": AGENTOS_OPENFGA_MODEL_VERSION,
      },
    },
    data: {
      "authorization-model-id": deployment.authorizationModelId,
      "model-created": String(deployment.modelCreated),
      "model-version": AGENTOS_OPENFGA_MODEL_VERSION,
      "previous-authorization-model-id":
        deployment.previousAuthorizationModelId ?? "",
      "store-id": deployment.storeId,
    },
  };
}

interface KubernetesRequest {
  readonly operation: typeof KubernetesOperation.Type;
  readonly method: "GET" | "POST" | "PUT";
  readonly url: URL;
  readonly body?: unknown;
  readonly acceptedStatuses: ReadonlyArray<number>;
}

function kubernetesRequest(
  options: OpenFgaKubernetesOptions,
  request: KubernetesRequest,
) {
  return Effect.gen(function*() {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    let clientRequest = HttpClientRequest.make(request.method)(request.url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader(
        "authorization",
        `Bearer ${Redacted.value(options.serviceAccountToken)}`,
      ),
    );
    if (request.body !== undefined) {
      clientRequest = yield* HttpClientRequest.bodyJson(
        clientRequest,
        request.body,
      ).pipe(
        Effect.mapError(() =>
          kubernetesError(
            request.operation,
            "invalid_configuration",
            null,
          )
        ),
      );
    }
    const response = yield* client.execute(clientRequest).pipe(
      Effect.mapError(() =>
        kubernetesError(request.operation, "network_failure", null)
      ),
      Effect.timeoutOrElse({
        duration: options.timeoutMillis,
        orElse: () =>
          kubernetesError(request.operation, "timeout", null),
      }),
    );
    if (!request.acceptedStatuses.includes(response.status)) {
      return yield* kubernetesError(
        request.operation,
        "unexpected_status",
        response.status,
      );
    }
    if (response.status !== 200) {
      return { status: response.status, body: null };
    }
    const body = yield* readBoundedJson(
      response,
      request.operation,
      options.maximumResponseBytes,
    );
    return { status: response.status, body };
  }).pipe(
    Effect.scoped,
  );
}

function readBoundedJson(
  response: HttpClientResponse.HttpClientResponse,
  operation: typeof KubernetesOperation.Type,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    return Effect.fail(
      kubernetesError(operation, "response_too_large", response.status),
    );
  }
  return response.stream.pipe(
    Stream.runFoldEffect(
      emptyBoundedBody,
      (state, chunk) => {
        const length = state.length + chunk.byteLength;
        if (length > maximumResponseBytes) {
          return Effect.fail(
            kubernetesError(
              operation,
              "response_too_large",
              response.status,
            ),
          );
        }
        return Effect.succeed({
          chunks: [...state.chunks, chunk],
          length,
        });
      },
    ),
    Effect.mapError((error) =>
      error instanceof OpenFgaKubernetesError
        ? error
        : kubernetesError(operation, "network_failure", response.status)
    ),
    Effect.map(decodeBoundedBody),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(body).pipe(
        Effect.mapError(() =>
          kubernetesError(operation, "invalid_response", response.status)
        ),
      )
    ),
  );
}

interface BoundedBody {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
}

function emptyBoundedBody(): BoundedBody {
  return { chunks: [], length: 0 };
}

function decodeBoundedBody(body: BoundedBody) {
  const bytes = new Uint8Array(body.length);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function kubernetesError(
  operation: typeof KubernetesOperation.Type,
  code: typeof KubernetesErrorCode.Type,
  status: number | null,
) {
  return OpenFgaKubernetesError.make({ operation, code, status });
}
