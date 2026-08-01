import { Effect, Redacted, Schema } from "effect";

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
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${Redacted.value(options.serviceAccountToken)}`,
  });
  if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return Effect.tryPromise({
    try: (signal) =>
      fetchImpl(request.url, {
        method: request.method,
        headers,
        body: request.body === undefined
          ? undefined
          : JSON.stringify(request.body),
        signal,
      }),
    catch: () =>
      kubernetesError(request.operation, "network_failure", null),
  }).pipe(
    Effect.flatMap((response) => {
      if (!request.acceptedStatuses.includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        return kubernetesError(
          request.operation,
          "unexpected_status",
          response.status,
        );
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        return Effect.succeed({ status: response.status, body: null });
      }
      return readBoundedJson(
        response,
        request.operation,
        options.maximumResponseBytes,
      ).pipe(Effect.map((body) => ({ status: response.status, body })));
    }),
    Effect.timeoutOrElse({
      duration: options.timeoutMillis,
      orElse: () =>
        kubernetesError(request.operation, "timeout", null),
    }),
  );
}

function readBoundedJson(
  response: Response,
  operation: typeof KubernetesOperation.Type,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    void response.body?.cancel().catch(() => undefined);
    return Effect.fail(
      kubernetesError(operation, "response_too_large", response.status),
    );
  }
  return Effect.gen(function*() {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let length = 0;
    while (true) {
      const result = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () =>
          kubernetesError(operation, "network_failure", response.status),
      });
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumResponseBytes) {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: () =>
            kubernetesError(operation, "network_failure", response.status),
        }).pipe(Effect.ignore);
        return yield* kubernetesError(
          operation,
          "response_too_large",
          response.status,
        );
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }).pipe(
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

function kubernetesError(
  operation: typeof KubernetesOperation.Type,
  code: typeof KubernetesErrorCode.Type,
  status: number | null,
) {
  return OpenFgaKubernetesError.make({ operation, code, status });
}
