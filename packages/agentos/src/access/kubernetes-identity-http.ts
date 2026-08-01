import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Scope,
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
  KubernetesTokenReviewer,
  KubernetesWorkloadIdentityLookup,
  WorkloadIdentityDependencyUnavailable,
  type KubernetesObjectReference,
  type KubernetesPodIdentityV1,
  type KubernetesReviewedIdentityV1,
  type KubernetesServiceAccountIdentityV1,
  type KubernetesTokenReviewRequest,
} from "./identity.ts";

export const KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const KUBERNETES_SERVICE_ACCOUNT_CA_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export interface KubernetesWorkloadIdentityHttpOptions {
  readonly baseUrl: string;
  readonly serviceAccountTokenPath: string;
  readonly timeoutMillis: number;
  readonly maximumResponseBytes: number;
}

export interface KubernetesWorkloadIdentityLiveOptions
  extends KubernetesWorkloadIdentityHttpOptions {
  readonly serviceAccountCaPath: string;
}

const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const KubernetesUid = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z](?:[0-9A-Za-z_.:-]*[0-9A-Za-z])?$/),
  ),
);
const HttpStatus = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(100),
    Schema.isLessThanOrEqualTo(599),
  ),
);
const KubernetesOperation = Schema.Literals([
  "configure_client",
  "review",
  "get_pod",
  "get_service_account",
]);
const KubernetesDependencyCode = Schema.Literals([
  "credential_unavailable",
  "trust_unavailable",
  "invalid_configuration",
  "network_failure",
  "timeout",
  "unexpected_status",
  "response_too_large",
  "invalid_response",
]);
const KubernetesObjectReferenceSchema = Schema.Struct({
  namespace: KubernetesName,
  name: KubernetesName,
});
const KubernetesTokenReviewRequestSchema = Schema.Struct({
  token: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^[^\s]+$/),
    ),
  ),
  audiences: Schema.Array(
    Schema.String.pipe(
      Schema.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(253),
        Schema.isPattern(/^[^\s]+$/),
      ),
    ),
  ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))),
});
const KubernetesUserExtraSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String),
);
const KubernetesTokenReviewResponseSchema = Schema.Struct({
  apiVersion: Schema.Literal("authentication.k8s.io/v1"),
  kind: Schema.Literal("TokenReview"),
  status: Schema.Struct({
    authenticated: Schema.optional(Schema.Boolean),
    audiences: Schema.optional(Schema.Array(Schema.String)),
    user: Schema.optional(Schema.Struct({
      username: Schema.optional(Schema.String),
      uid: Schema.optional(KubernetesUid),
      extra: Schema.optional(KubernetesUserExtraSchema),
    })),
  }),
});
const KubernetesPodResponseSchema = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("Pod"),
  metadata: Schema.Struct({
    namespace: KubernetesName,
    name: KubernetesName,
    uid: KubernetesUid,
    deletionTimestamp: Schema.optional(Schema.DateTimeUtcFromString),
  }),
  spec: Schema.Struct({ serviceAccountName: KubernetesName }),
  status: Schema.Struct({
    phase: Schema.Literals([
      "Pending",
      "Running",
      "Succeeded",
      "Failed",
      "Unknown",
    ]),
  }),
});
const KubernetesServiceAccountResponseSchema = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("ServiceAccount"),
  metadata: Schema.Struct({
    namespace: KubernetesName,
    name: KubernetesName,
    uid: KubernetesUid,
    deletionTimestamp: Schema.optional(Schema.DateTimeUtcFromString),
  }),
});
const KubernetesStatusResponseSchema = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("Status"),
  status: Schema.optional(Schema.Literals(["Success", "Failure"])),
  reason: Schema.optional(Schema.String),
  code: Schema.optional(HttpStatus),
});
const JsonBodySchema = Schema.fromJsonString(Schema.Unknown);

type KubernetesOperation = typeof KubernetesOperation.Type;
type KubernetesDependencyCode = typeof KubernetesDependencyCode.Type;

interface KubernetesHttpRuntime {
  readonly client: HttpClient.HttpClient.With<
    HttpClientError.HttpClientError,
    Scope.Scope
  >;
  readonly fileSystem: FileSystem.FileSystem;
  readonly baseUrl: URL;
}

interface BoundedResponseBody {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
}

export function makeKubernetesWorkloadIdentityHttpLayer(
  options: KubernetesWorkloadIdentityHttpOptions,
) {
  return Layer.effectContext(
    Effect.gen(function*() {
      const runtime = yield* makeRuntime(options);
      const reviewer = KubernetesTokenReviewer.of({
        review: Effect.fn("agentos.kubernetes.token_review")(
          (request: KubernetesTokenReviewRequest) =>
            runScopedRequest(
              reviewToken(runtime, options, request),
              options,
              "review",
            ),
        ),
      });
      const lookup = KubernetesWorkloadIdentityLookup.of({
        getPod: Effect.fn("agentos.kubernetes.get_pod")(
          (reference: KubernetesObjectReference) =>
            runScopedRequest(
              getPod(runtime, options, reference),
              options,
              "get_pod",
            ),
        ),
        getServiceAccount: Effect.fn("agentos.kubernetes.get_service_account")(
          (reference: KubernetesObjectReference) =>
            runScopedRequest(
              getServiceAccount(runtime, options, reference),
              options,
              "get_service_account",
            ),
        ),
      });
      return Context.make(KubernetesTokenReviewer, reviewer).pipe(
        Context.add(KubernetesWorkloadIdentityLookup, lookup),
      );
    }),
  );
}

export function makeKubernetesApiHttpClientLayer(
  options: Pick<KubernetesWorkloadIdentityLiveOptions, "serviceAccountCaPath">,
) {
  return Layer.unwrap(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const ca = yield* fileSystem.readFileString(
        options.serviceAccountCaPath,
      ).pipe(
        Effect.mapError(() =>
          dependencyError(
            "configure_client",
            "trust_unavailable",
            null,
          )
        ),
      );
      if (ca.trim().length === 0) {
        return yield* dependencyError(
          "configure_client",
          "trust_unavailable",
          null,
        );
      }
      const requestInit: BunFetchRequestInit = { tls: { ca } };
      return FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.RequestInit, requestInit),
        ),
      );
    }),
  );
}

export function makeKubernetesWorkloadIdentityLiveLayer(
  options: KubernetesWorkloadIdentityLiveOptions,
) {
  return makeKubernetesWorkloadIdentityHttpLayer(options).pipe(
    Layer.provide(makeKubernetesApiHttpClientLayer(options)),
  );
}

const makeRuntime = Effect.fn("agentos.kubernetes.make_runtime")(
  function*(options: KubernetesWorkloadIdentityHttpOptions) {
    const baseUrl = yield* Effect.try({
      try: () => new URL(options.baseUrl),
      catch: () =>
        dependencyError("configure_client", "invalid_configuration", null),
    });
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.username.length > 0 ||
      baseUrl.password.length > 0 ||
      baseUrl.pathname !== "/" ||
      baseUrl.search.length > 0 ||
      baseUrl.hash.length > 0
    ) {
      return yield* dependencyError(
        "configure_client",
        "invalid_configuration",
        null,
      );
    }
    if (
      !Number.isSafeInteger(options.timeoutMillis) ||
      options.timeoutMillis <= 0 ||
      !Number.isSafeInteger(options.maximumResponseBytes) ||
      options.maximumResponseBytes <= 0
    ) {
      return yield* dependencyError(
        "configure_client",
        "invalid_configuration",
        null,
      );
    }
    return {
      client: HttpClient.withScope(yield* HttpClient.HttpClient),
      fileSystem: yield* FileSystem.FileSystem,
      baseUrl,
    } satisfies KubernetesHttpRuntime;
  },
);

function reviewToken(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  request: KubernetesTokenReviewRequest,
) {
  return Schema.decodeUnknownEffect(KubernetesTokenReviewRequestSchema)(
    request,
  ).pipe(
    Effect.mapError(() =>
      dependencyError("review", "invalid_configuration", null)
    ),
    Effect.flatMap((valid) =>
      executeJsonRequest(
        runtime,
        options,
        "review",
        "POST",
        "/apis/authentication.k8s.io/v1/tokenreviews",
        {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: {
            token: valid.token,
            audiences: valid.audiences,
          },
        },
        [200, 201],
        KubernetesTokenReviewResponseSchema,
      )
    ),
    Effect.map(({ status }) => {
      const user = status.user;
      const extra = user?.extra;
      return {
        authenticated: status.authenticated ?? false,
        audiences: status.audiences ?? [],
        username: user?.username ?? null,
        serviceAccountUid: user?.uid ?? null,
        podNames: extra?.["authentication.kubernetes.io/pod-name"] ?? [],
        podUids: extra?.["authentication.kubernetes.io/pod-uid"] ?? [],
      } satisfies KubernetesReviewedIdentityV1;
    }),
  );
}

function getPod(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  reference: KubernetesObjectReference,
) {
  return validateReference(reference, "get_pod").pipe(
    Effect.flatMap((valid) =>
      executeOptionalJsonRequest(
        runtime,
        options,
        "get_pod",
        `/api/v1/namespaces/${valid.namespace}/pods/${valid.name}`,
        KubernetesPodResponseSchema,
      )
    ),
    Effect.map((response): KubernetesPodIdentityV1 | null =>
      response === null
        ? null
        : {
          namespace: response.metadata.namespace,
          name: response.metadata.name,
          uid: response.metadata.uid,
          serviceAccountName: response.spec.serviceAccountName,
          phase: response.status.phase,
          deletionTimestampMillis: response.metadata.deletionTimestamp ===
              undefined
            ? null
            : DateTime.toEpochMillis(response.metadata.deletionTimestamp),
        }
    ),
  );
}

function getServiceAccount(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  reference: KubernetesObjectReference,
) {
  return validateReference(reference, "get_service_account").pipe(
    Effect.flatMap((valid) =>
      executeOptionalJsonRequest(
        runtime,
        options,
        "get_service_account",
        `/api/v1/namespaces/${valid.namespace}/serviceaccounts/${valid.name}`,
        KubernetesServiceAccountResponseSchema,
      )
    ),
    Effect.map((response): KubernetesServiceAccountIdentityV1 | null =>
      response === null
        ? null
        : {
          namespace: response.metadata.namespace,
          name: response.metadata.name,
          uid: response.metadata.uid,
          deletionTimestampMillis: response.metadata.deletionTimestamp ===
              undefined
            ? null
            : DateTime.toEpochMillis(response.metadata.deletionTimestamp),
        }
    ),
  );
}

function executeOptionalJsonRequest<S extends Schema.Top>(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  operation: KubernetesOperation,
  path: string,
  schema: S,
) {
  return executeRequest(runtime, options, operation, "GET", path).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.succeed(null);
      if (response.status !== 200) {
        return discardStatusResponse(response, operation, options).pipe(
          Effect.andThen(
            dependencyError(operation, "unexpected_status", response.status),
          ),
        );
      }
      return decodeResponse(response, operation, options, schema);
    }),
  );
}

function executeJsonRequest<S extends Schema.Top>(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  operation: KubernetesOperation,
  method: "POST",
  path: string,
  body: unknown,
  acceptedStatuses: ReadonlyArray<number>,
  schema: S,
) {
  return executeRequest(runtime, options, operation, method, path, body).pipe(
    Effect.flatMap((response) => {
      if (!acceptedStatuses.includes(response.status)) {
        return discardStatusResponse(response, operation, options).pipe(
          Effect.andThen(
            dependencyError(operation, "unexpected_status", response.status),
          ),
        );
      }
      return decodeResponse(response, operation, options, schema);
    }),
  );
}

function executeRequest(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  operation: KubernetesOperation,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const requestEffect = Effect.gen(function*() {
    const clientToken = yield* readClientToken(runtime, options, operation);
    const url = yield* Effect.try({
      try: () => new URL(path, ensureTrailingSlash(runtime.baseUrl)),
      catch: () => dependencyError(operation, "invalid_configuration", null),
    });
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("authorization", `Bearer ${clientToken}`),
    );
    if (body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(() =>
          dependencyError(operation, "invalid_configuration", null)
        ),
      );
    }
    return yield* runtime.client.execute(request).pipe(
      Effect.mapError(() => dependencyError(operation, "network_failure", null)),
    );
  });
  return requestEffect;
}

function runScopedRequest<A, E>(
  request: Effect.Effect<A, E, Scope.Scope>,
  options: KubernetesWorkloadIdentityHttpOptions,
  operation: "review" | "get_pod" | "get_service_account",
) {
  return request.pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMillis,
      orElse: () => dependencyError(operation, "timeout", null),
    }),
    Effect.scoped,
  );
}

function readClientToken(
  runtime: KubernetesHttpRuntime,
  options: KubernetesWorkloadIdentityHttpOptions,
  operation: KubernetesOperation,
) {
  return runtime.fileSystem.readFileString(
    options.serviceAccountTokenPath,
  ).pipe(
    Effect.mapError(() =>
      dependencyError(operation, "credential_unavailable", null)
    ),
    Effect.flatMap((value) => {
      const token = value.trim();
      return token.length > 0 && token.length <= 16_384 && !/\s/.test(token)
        ? Effect.succeed(token)
        : dependencyError(operation, "credential_unavailable", null);
    }),
  );
}

function decodeResponse<S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  operation: KubernetesOperation,
  options: KubernetesWorkloadIdentityHttpOptions,
  schema: S,
) {
  return readBoundedJson(response, operation, options.maximumResponseBytes).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof WorkloadIdentityDependencyUnavailable
        ? error
        : dependencyError(operation, "invalid_response", response.status)
    ),
  );
}

function discardStatusResponse(
  response: HttpClientResponse.HttpClientResponse,
  operation: KubernetesOperation,
  options: KubernetesWorkloadIdentityHttpOptions,
) {
  return readBoundedJson(response, operation, options.maximumResponseBytes).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(KubernetesStatusResponseSchema)),
    Effect.asVoid,
    Effect.catch((error) =>
      error instanceof WorkloadIdentityDependencyUnavailable &&
          (error.code === "response_too_large" ||
            error.code === "network_failure")
        ? Effect.fail(error)
        : Effect.void
    ),
  );
}

function readBoundedJson(
  response: HttpClientResponse.HttpClientResponse,
  operation: KubernetesOperation,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    return dependencyError(
      operation,
      "response_too_large",
      response.status,
    );
  }
  return response.stream.pipe(
    Stream.runFoldEffect(emptyBoundedBody, (state, chunk) => {
      const length = state.length + chunk.byteLength;
      if (length > maximumResponseBytes) {
        return dependencyError(
          operation,
          "response_too_large",
          response.status,
        );
      }
      return Effect.succeed({
        chunks: [...state.chunks, chunk],
        length,
      });
    }),
    Effect.mapError((error) =>
      error instanceof WorkloadIdentityDependencyUnavailable
        ? error
        : dependencyError(operation, "network_failure", response.status)
    ),
    Effect.map(decodeBoundedBody),
    Effect.flatMap(Schema.decodeUnknownEffect(JsonBodySchema)),
    Effect.mapError((error) =>
      error instanceof WorkloadIdentityDependencyUnavailable
        ? error
        : dependencyError(operation, "invalid_response", response.status)
    ),
  );
}

function emptyBoundedBody(): BoundedResponseBody {
  return { chunks: [], length: 0 };
}

function decodeBoundedBody(body: BoundedResponseBody) {
  const bytes = new Uint8Array(body.length);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateReference(
  reference: KubernetesObjectReference,
  operation: "get_pod" | "get_service_account",
) {
  return Schema.decodeUnknownEffect(KubernetesObjectReferenceSchema)(
    reference,
  ).pipe(
    Effect.mapError(() =>
      dependencyError(operation, "invalid_configuration", null)
    ),
  );
}

function dependencyError(
  operation: KubernetesOperation,
  code: KubernetesDependencyCode,
  status: number | null,
) {
  return WorkloadIdentityDependencyUnavailable.make({
    dependency: operation === "review" ? "token_review" : "kubernetes",
    operation,
    code,
    status,
  });
}

function ensureTrailingSlash(url: URL) {
  return url.pathname.endsWith("/")
    ? url
    : new URL(`${url.pathname}/`, url);
}
